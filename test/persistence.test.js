import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, tempDir, seqRng } from './helpers.js';

const user = { twitchId: '5001', login: 'luigi', displayName: 'Luigi' };

describe('Riavvio server e persistenza', () => {
  test('i dati sopravvivono al riavvio e la diretta in corso viene ripresa senza duplicati', async () => {
    const dir = tempDir();
    const tw = new FakeTwitch();
    const es = await new FakeEventSub().start();
    try {
      // Primo avvio: diretta in corso, una cattura.
      let rng = seqRng();
      let { app } = await makeApp({ dir, twitch: tw, eventsub: es, rng });
      seedPokemon(app.db);
      const reward = linkReward(app);
      tw.live = { id: 'live-42' };
      await app.monitor.start();
      await waitFor(() => app.sm.state === 'LIVE');
      const sessionId = app.engine.sessions.current(false).id;
      app.engine.tick();
      rng.push(0.0);
      app.engine.attempt({ redemptionId: 'p1', rewardId: reward.rewardId, user });
      app.engine.tick(); // spawn attivo al momento del "crash"
      await app.close();

      // Secondo avvio sullo stesso volume.
      rng = seqRng();
      ({ app } = await makeApp({ dir, twitch: tw, eventsub: es, rng, configureTwitch: false }));
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1, 'collezione conservata');
      assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 0, 'spawn orfani chiusi');
      assert.equal(app.credentials.getToken('broadcaster').accessToken, 'access', 'token cifrati e ricaricati');
      await app.monitor.start();
      await waitFor(() => app.sm.state === 'LIVE');
      assert.equal(app.engine.sessions.current(false).id, sessionId, 'stessa sessione ripresa');
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stream_sessions').n, 1);
      await app.close();

      // Terzo avvio a diretta terminata mentre il server era spento: la sessione viene chiusa.
      tw.live = null;
      ({ app } = await makeApp({ dir, twitch: tw, eventsub: es, configureTwitch: false }));
      await app.monitor.start();
      await waitFor(() => app.sm.state === 'OFFLINE');
      assert.ok(app.engine.sessions.byId(sessionId).ended_at, 'sessione chiusa');
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1);
      await app.close();
    } finally {
      await es.stop();
      cleanup(dir);
    }
  });

  test('le migrazioni sono idempotenti e il segreto non è salvato in chiaro', async () => {
    const dir = tempDir();
    try {
      let { app } = await makeApp({ dir });
      const raw = app.db.get("SELECT value FROM admin_settings WHERE key = 'twitch_credentials'").value;
      assert.ok(!raw.includes('testsecret000000'), 'client secret cifrato');
      assert.ok(!raw.includes('"access"'), 'token cifrato');
      await app.close();
      ({ app } = await makeApp({ dir, configureTwitch: false }));
      assert.equal(app.db.schemaVersion(), 1);
      assert.equal(app.credentials.clientSecret, 'testsecret000000');
      await app.close();
    } finally { cleanup(dir); }
  });
});

describe('Backup e ripristino', () => {
  test('backup manuale, modifica dati, ripristino', async () => {
    const { app, dir } = await makeApp({ configureTwitch: false });
    try {
      seedPokemon(app.db);
      app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('9', 'peach', 'Peach')");
      app.db.run('INSERT INTO user_pokemon (user_id, pokemon_id) VALUES (1, 1)');
      const b = app.backups.create('manual');
      assert.match(b.filename, /^livecatch-\d{8}-\d{6}-manual\.sqlite\.gz$/);

      app.db.run('DELETE FROM user_pokemon');
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);

      const r = await app.restore(b.filename);
      assert.ok(r.safetyBackup.includes('pre-restore'));
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1, 'dati ripristinati');
      assert.ok(app.backups.list().some((x) => x.filename === r.safetyBackup), 'backup di sicurezza presente');
    } finally { await app.close(); cleanup(dir); }
  });

  test('ripristino rifiutato durante una diretta e nomi file non validi', async () => {
    const { app, dir } = await makeApp({ configureTwitch: false });
    try {
      const b = app.backups.create('manual');
      app.sm.transition('LIVE', 'test');
      await assert.rejects(() => app.restore(b.filename), /durante una diretta/);
      assert.throws(() => app.backups.path('../../etc/passwd'), /non valido/);
      assert.throws(() => app.backups.saveUpload(Buffer.from('non sono un database')), /SQLite/);
    } finally { await app.close(); cleanup(dir); }
  });

  test('rotazione dei backup automatici e backup giornaliero una volta al giorno', async () => {
    const { app, dir } = await makeApp({ configureTwitch: false });
    try {
      app.adminSettings.set('backup', { autoEnabled: true, hour: 0, keep: 2 });
      const first = app.backups.checkAuto(new Date());
      assert.ok(first);
      assert.equal(app.backups.checkAuto(new Date()), null, 'non ripete nello stesso giorno');
      for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 1100)); app.backups.create('auto'); }
      assert.equal(app.backups.list().filter((x) => x.kind === 'auto' && x.exists).length, 2);
    } finally { await app.close(); cleanup(dir); }
  });

  test('esportazione e importazione JSON', async () => {
    const a = await makeApp({ configureTwitch: false });
    const b = await makeApp({ configureTwitch: false });
    try {
      seedPokemon(a.app.db);
      seedPokemon(b.app.db);
      a.app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('77', 'toad', 'Toad')");
      a.app.db.run('INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny) VALUES (1, 2, 1)');
      const data = a.app.backups.exportJson();
      const res = b.app.backups.importJson(JSON.parse(JSON.stringify(data)));
      assert.deepEqual(res, { users: 1, pokemon: 1, skipped: 0 });
      assert.equal(b.app.backups.importJson(data).skipped, 1, 'merge senza duplicati');
      assert.equal(b.app.db.get('SELECT is_shiny FROM user_pokemon').is_shiny, 1);
    } finally {
      await a.app.close(); await b.app.close(); cleanup(a.dir); cleanup(b.dir);
    }
  });
});

describe('Recupero password amministratore', () => {
  test('il file reset-admin-password genera una password temporanea', async () => {
    const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = tempDir();
    try {
      let { app } = await makeApp({ dir, configureTwitch: false });
      await app.auth.changePassword(1, 'initialpass123', 'Dimenticata2026', null);
      await app.close();
      writeFileSync(join(dir, 'reset-admin-password'), '');
      ({ app } = await makeApp({ dir, configureTwitch: false }));
      assert.ok(!existsSync(join(dir, 'reset-admin-password')));
      const pw = /Password temporanea: (\S+)/.exec(readFileSync(join(dir, 'initial-admin-password.txt'), 'utf8'))[1];
      const r = await app.auth.login('admin', pw);
      assert.ok(r);
      assert.equal(r.mustChangePassword, true);
      await app.close();
    } finally { cleanup(dir); }
  });
});
