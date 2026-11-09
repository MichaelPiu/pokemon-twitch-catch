// Chiamate HTTP verso Twitch (Helix e id.twitch.tv) con timeout e ritentativi.
//
// Errori temporanei: rete assente, timeout, HTTP 429 e 5xx. Vengono ritentati
// con attesa crescente (e rispettando Retry-After / Ratelimit-Reset di Twitch);
// se il problema persiste la chiamata fallisce con `transient: true`, che il
// resto dell'app NON tratta come una revoca dell'autorizzazione.
//
// Le richieste non idempotenti (POST) vengono ritentate solo dopo un 429, cioè
// quando Twitch dichiara di non averle elaborate: un 5xx o un timeout su una POST
// potrebbe essere già stato applicato (es. messaggio in chat inviato due volte).

export const HTTP_DEFAULTS = { timeoutMs: 10000, retries: 2, baseDelayMs: 500, maxDelayMs: 15000 };

export function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export class TwitchTransientError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.transient = true;
    this.authInvalid = false;
    if (status) this.status = status;
  }
}

// Attesa richiesta da Twitch in millisecondi, o null se assente/non valida.
export function retryAfterMs(res, now = Date.now()) {
  const h = res?.headers;
  if (!h?.get) return null;
  const ra = h.get('retry-after');
  if (ra != null && ra !== '') {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  // Helix: Ratelimit-Reset = istante (secondi Unix) in cui il secchio si riempie.
  const reset = Number(h.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return null;
}

const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function describe(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  return e?.cause?.code || e?.message || 'errore di rete';
}

// Esegue fetch con timeout e ritentativi. Ritorna la Response (anche 4xx);
// lancia TwitchTransientError se dopo i ritentativi resta rete assente/timeout
// o un 429/5xx.
export async function fetchWithRetry(fetchImpl, url, init = {}, opts = {}) {
  const o = { ...HTTP_DEFAULTS, ...opts };
  const sleep = o.sleep || defaultSleep;
  const method = String(init.method || 'GET').toUpperCase();
  const idempotent = method !== 'POST' || o.idempotent === true;
  const label = o.label || `${method} ${new URL(String(url)).pathname}`;
  for (let attempt = 0; ; attempt++) {
    const backoff = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (e) {
      const why = describe(e);
      if (idempotent && attempt < o.retries) {
        o.log?.warn?.(`Twitch non raggiungibile (${label}: ${why}), nuovo tentativo`, { attempt: attempt + 1 });
        await sleep(backoff);
        continue;
      }
      throw new TwitchTransientError(`Twitch non raggiungibile (${label}: ${why})`, { cause: e });
    }
    if (!isTransientStatus(res.status)) return res;
    const canRetry = attempt < o.retries && (idempotent || res.status === 429);
    const wait = retryAfterMs(res);
    // Un'attesa richiesta più lunga del massimo non viene ignorata: si rinuncia
    // per ora e si riprova al prossimo ciclo, senza martellare Twitch.
    if (!canRetry || (wait != null && wait > o.maxDelayMs)) {
      await res.text().catch(() => {});
      throw new TwitchTransientError(`Twitch temporaneamente non disponibile (${label}: HTTP ${res.status})`, { status: res.status });
    }
    await res.text().catch(() => {});
    o.log?.warn?.(`Twitch ha risposto ${res.status} (${label}), nuovo tentativo`, { attempt: attempt + 1 });
    await sleep(wait != null ? wait : backoff);
  }
}
