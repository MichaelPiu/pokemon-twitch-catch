// Stato delle riscossioni su Twitch e recupero dei riscatti persi.
//
// 1) Ogni tentativo elaborato riceve uno "stato desiderato" su Twitch
//    (FULFILLED = punti spesi, CANCELED = punti rimborsati). L'aggiornamento viene
//    salvato nel database PRIMA della chiamata a Twitch: se la chiamata fallisce
//    (rete, token, Twitch non disponibile) viene ritentato in seguito.
// 2) Dopo una riconnessione EventSub, all'avvio e periodicamente, l'app legge da
//    Twitch i riscatti ancora in coda (UNFULFILLED) delle ricompense create
//    dall'app e:
//      - se non li conosce (persi durante la disconnessione) li elabora ora,
//        con l'orario reale del riscatto: le regole su spawn, ritardi e stato
//        offline decidono se il lancio è valido o va rimborsato;
//      - se li conosce ma lo stato su Twitch non è stato aggiornato, ripete
//        l'aggiornamento.
//
// Limite di Twitch: lettura e modifica dei riscatti sono consentite SOLO per le
// ricompense create con lo stesso Client ID (ricompense "create dall'app").
// Per le ricompense collegate manualmente non è possibile né recuperare i
// riscatti persi né rimborsarli automaticamente.

const MAX_TRIES = 6;
const MAX_PAGES = 10;

export class RedemptionReconciler {
  constructor({ db, helix, credentials, gameSettings, log, process }) {
    this.db = db;
    this.helix = helix;
    this.creds = credentials;
    this.gameSettings = gameSettings;
    this.log = log;
    this.process = process; // (redemption, { source }) => risultato elaborazione
    this.running = null;
    this.last = null;
    this.lastRunAt = 0;
  }

  broadcasterId() { return this.creds.getToken('broadcaster')?.userId || null; }

  // Stato da impostare su Twitch per un tentativo, secondo le impostazioni.
  desiredFor(attempt) {
    const c = this.gameSettings.get('capture');
    if (attempt.outcome === 'rejected') return c.refundRejected ? 'CANCELED' : null;
    return c.fulfillProcessed ? 'FULFILLED' : null;
  }

  // Registra lo stato desiderato e prova ad applicarlo subito.
  async setDesired(redemptionId, status) {
    if (!status) return null;
    this.db.run('UPDATE capture_attempts SET desired_status = ? WHERE redemption_id = ?', status, redemptionId);
    const a = this.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', redemptionId);
    return a ? this.push(a) : null;
  }

  async push(attempt) {
    const bid = this.broadcasterId();
    const status = attempt.desired_status;
    if (!bid || !status || !attempt.reward_id || !attempt.redemption_id) return { ok: false, reason: 'not_applicable' };
    try {
      await this.helix.updateRedemption(bid, attempt.reward_id, attempt.redemption_id, status);
      this.db.run('UPDATE capture_attempts SET redemption_status = ?, status_error = NULL WHERE id = ?', status, attempt.id);
      return { ok: true, status };
    } catch (e) {
      // 404: la riscossione non è più in coda (già gestita a mano su Twitch o eliminata):
      // inutile ritentare.
      const final = e.status === 404;
      // Token revocato/scaduto: non consuma i tentativi, il rimborso viene
      // completato dopo il ricollegamento dell'account.
      const auth = !final && (e.authInvalid || e.status === 401);
      const msg = final ? 'riscossione non più in coda su Twitch (già gestita?)'
        : auth ? 'account Twitch del canale non autorizzato: verrà ritentato dopo il ricollegamento'
          : (e.message || 'errore sconosciuto').slice(0, 300);
      // Limite di richieste (429) o Twitch non raggiungibile (rete, timeout): la
      // richiesta non è stata elaborata, quindi non consuma i tentativi.
      const unreached = !final && !auth && e.transient && (e.status === 429 || !e.status);
      const tries = final ? MAX_TRIES : (auth || unreached) ? (attempt.status_tries || 0) : (attempt.status_tries || 0) + 1;
      this.db.run('UPDATE capture_attempts SET status_error = ?, status_tries = ? WHERE id = ?', msg, tries, attempt.id);
      this.log.warn('Aggiornamento riscossione su Twitch non riuscito', { status, http: e.status, message: msg });
      return { ok: false, error: msg };
    }
  }

  // Avvia (o riusa) una riconciliazione in corso.
  run(reason = 'manual') {
    if (!this.running) {
      this.running = this.doRun(reason).finally(() => { this.running = null; });
    }
    return this.running;
  }

  async doRun(reason) {
    if (!this.db?.db) return null;
    const cfg = this.gameSettings.get('rewards');
    const bid = this.broadcasterId();
    const result = { at: new Date().toISOString(), reason, checked: 0, recovered: 0, retried: 0, errors: [], skipped: null };
    this.lastRunAt = Date.now();
    if (!cfg.reconcileEnabled) { result.skipped = 'disattivato'; this.last = result; return result; }
    if (!bid) { result.skipped = 'account del canale non collegato'; this.last = result; return result; }

    const rewards = this.db.all('SELECT * FROM twitch_rewards WHERE managed_by_app = 1');
    for (const rw of rewards) {
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        let res;
        try {
          res = await this.helix.getRedemptions(bid, rw.reward_id, { status: 'UNFULFILLED', after });
        } catch (e) {
          const msg = e.status === 403
            ? `"${rw.title}": Twitch non consente di leggere i riscatti (ricompensa non creata da questa app o permesso mancante)`
            : `"${rw.title}": ${e.message}`;
          result.errors.push(msg);
          this.log.warn('Recupero riscatti non riuscito', { reward: rw.title, http: e.status, message: e.message });
          break;
        }
        for (const red of res.data) {
          result.checked++;
          const known = this.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', red.id);
          if (!known) {
            try {
              this.process({ ...red, status: String(red.status || 'UNFULFILLED').toLowerCase() }, { source: 'recovered' });
              result.recovered++;
            } catch (e) {
              result.errors.push(`riscatto ${red.id}: ${e.message}`);
              this.log.error('Elaborazione riscatto recuperato fallita', { message: e.message });
            }
            continue;
          }
          const desired = known.desired_status || this.desiredFor(known);
          if (!desired || (known.status_tries || 0) >= MAX_TRIES) continue;
          if (!known.desired_status) this.db.run('UPDATE capture_attempts SET desired_status = ? WHERE id = ?', desired, known.id);
          const r = await this.push({ ...known, desired_status: desired });
          result.retried++;
          if (!r.ok) result.errors.push(`riscatto ${red.id}: ${r.error}`);
        }
        after = res.cursor;
        if (!after || !res.data.length) break;
      }
    }
    if (result.recovered || result.retried || result.errors.length) {
      this.log.info(`Riconciliazione riscatti (${reason}): ${result.recovered} recuperati, ${result.retried} aggiornati, ${result.errors.length} errori`);
    }
    this.last = result;
    return result;
  }

  // Tentativi il cui stato su Twitch non è ancora quello previsto.
  pending(limit = 50) {
    return this.db.all(
      `SELECT a.id, a.redemption_id, a.reward_id, a.outcome, a.reject_reason, a.desired_status, a.redemption_status, a.status_error,
              a.status_tries, a.source, a.created_at, u.display_name AS user, r.title AS reward
       FROM capture_attempts a JOIN twitch_users u ON u.id = a.user_id LEFT JOIN twitch_rewards r ON r.reward_id = a.reward_id
       WHERE a.is_demo = 0 AND a.desired_status IS NOT NULL AND (a.redemption_status IS NULL OR a.redemption_status != a.desired_status)
       ORDER BY a.id DESC LIMIT ?`, limit);
  }

  recentRecovered(limit = 20) {
    return this.db.all(
      `SELECT a.id, a.redemption_id, a.outcome, a.reject_reason, a.redemption_status, a.redeemed_at, a.created_at, u.display_name AS user
       FROM capture_attempts a JOIN twitch_users u ON u.id = a.user_id
       WHERE a.source = 'recovered' ORDER BY a.id DESC LIMIT ?`, limit);
  }
}
