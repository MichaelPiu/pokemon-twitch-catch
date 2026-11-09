// Test specifici delle correzioni di sicurezza della 1.0:
// proxy fidati / X-Forwarded-For, Origin e Host del WebSocket admin,
// isolamento delle sessioni amministrative, hostname dedicato.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { makeApp, cleanup, tempDir, rawRequest } from './helpers.js';
import { ProxyTrust, readDockerGateways } from '../src/security/proxy.js';
import { migrations } from '../src/database/migrations.js';

const UA = 'Mozilla/5.0 (Test) LiveCatch';
const NEWPW = 'NuovaPassword2026';

// Avvia un'app in ascolto e restituisce porta e funzioni di supporto.
async function serve(opts = {}) {
  const ctx = await makeApp({ configureTwitch: false, ...opts });
  const port = await ctx.app.listen(0, '127.0.0.1');
  const call = (method, path, { body, headers = {}, cookie, csrf } = {}) => rawRequest(port, {
    method, path, body,
    headers: { 'User-Agent': UA, Host: `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
  });
  // Login + cambio password obbligatorio; restituisce cookie e token CSRF.
  const login = async (headers = {}, password = 'initialpass123') => {
    const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password }, headers });
    assert.equal(r.status, 200, `login: ${r.text}`);
    const cookie = String(r.headers['set-cookie'][0]).split(';')[0];
    if (r.data.mustChangePassword) {
      const c = await call('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: NEWPW }, headers, cookie, csrf: r.data.csrf });
      assert.equal(c.status, 200, `cambio password: ${c.text}`);
    }
    return { cookie, csrf: r.data.csrf, setCookie: String(r.headers['set-cookie'][0]) };
  };
  return { ...ctx, port, call, login, close: async () => { await ctx.app.close(); cleanup(ctx.dir); } };
}

function wsStatus(port, path, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode }));
    ws.on('message', (m) => { const msg = JSON.parse(m); ws.close(); resolve({ status: 101, first: msg.type }); });
    ws.on('error', (e) => resolve({ status: 'error', error: e.message }));
  });
}

describe('Proxy fidati e X-Forwarded-For (unità)', () => {
  const req = (peer, xff, proto) => ({ socket: { remoteAddress: peer }, headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...(proto ? { 'x-forwarded-proto': proto } : {}) } });

  test('senza proxy configurati gli header inoltrati vengono ignorati', () => {
    const p = new ProxyTrust({ spec: '' });
    assert.equal(p.clientIp(req('192.168.1.20', '1.2.3.4')), '192.168.1.20');
    assert.equal(p.isHttps(req('192.168.1.20', null, 'https')), false);
  });

  test('peer non autorizzato: X-Forwarded-For ignorato anche se il proxy è configurato', () => {
    const p = new ProxyTrust({ spec: '10.21.0.1' });
    assert.equal(p.clientIp(req('192.168.1.66', '8.8.8.8')), '192.168.1.66');
  });

  test('peer autorizzato: si usa l\'ultimo indirizzo non fidato (valori a sinistra falsificabili ignorati)', () => {
    const p = new ProxyTrust({ spec: '10.21.0.1' });
    assert.equal(p.clientIp(req('10.21.0.1', '1.1.1.1')), '1.1.1.1');
    assert.equal(p.clientIp(req('10.21.0.1', '6.6.6.6, 192.168.1.50')), '192.168.1.50');
    assert.equal(p.clientIp(req('::ffff:10.21.0.1', '192.168.1.50')), '192.168.1.50');
    assert.equal(p.clientIp(req('10.21.0.1', 'nonunip')), '10.21.0.1', 'header malformato: si usa il peer');
    assert.equal(p.clientIp(req('10.21.0.1')), '10.21.0.1');
    assert.equal(p.isHttps(req('10.21.0.1', null, 'https')), true);
  });

  test('catena di proxy fidati, CIDR e loopback', () => {
    const p = new ProxyTrust({ spec: 'loopback,10.21.0.0/16' });
    assert.equal(p.clientIp(req('127.0.0.1', '192.168.1.7, 10.21.0.5')), '192.168.1.7');
    assert.equal(p.isTrusted('10.21.200.3'), true);
    assert.equal(p.isTrusted('10.22.0.1'), false);
  });

  test('docker-gateway letto dalla tabella di routing del container', () => {
    const dir = tempDir();
    const f = join(dir, 'route');
    writeFileSync(f, 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n'
      + 'eth0\t00000000\t010015AC\t0003\t0\t0\t0\t00000000\n'
      + 'eth0\t000015AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n');
    assert.deepEqual(readDockerGateways(f), ['172.21.0.1']);
    const p = new ProxyTrust({ spec: 'docker-gateway', routeFile: f });
    assert.equal(p.clientIp(req('172.21.0.1', '192.168.1.80')), '192.168.1.80');
    assert.equal(p.clientIp(req('172.21.0.9', '192.168.1.80')), '172.21.0.9', 'altri container non sono fidati');
    cleanup(dir);
  });

  test('nome host del proxy risolto via DNS', async () => {
    const p = new ProxyTrust({ spec: 'piu-live-catch_app_proxy_1', resolver: async () => [{ address: '10.21.0.7', family: 4 }] });
    await p.start();
    assert.equal(p.clientIp(req('10.21.0.7', '192.168.1.81')), '192.168.1.81');
    p.stop();
  });
});

describe('Rate limiting con header falsificati', () => {
  test('senza proxy fidati: cambiare X-Forwarded-For non aggira il limite', async () => {
    const s = await serve();
    try {
      const codes = [];
      for (let i = 1; i <= 12; i++) {
        const r = await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'sbagliata' }, headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
        codes.push(r.status);
      }
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
      assert.deepEqual(codes.slice(10), [429, 429]);
    } finally { await s.close(); }
  });

  test('con proxy fidato: limite per IP reale e limite per account indipendente dall\'IP', async () => {
    const s = await serve({ env: { TRUSTED_PROXIES: '127.0.0.1' } });
    try {
      // Un client reale (IP inoltrato dal proxy) viene limitato a 10 tentativi.
      for (let i = 0; i < 10; i++) {
        assert.equal((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'x' }, headers: { 'X-Forwarded-For': '192.168.1.50' } })).status, 401);
      }
      assert.equal((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'x' }, headers: { 'X-Forwarded-For': '192.168.1.50' } })).status, 429);
      // Un attaccante che riuscisse a variare l'IP viene fermato dal limite per account (30 errori).
      const codes = [];
      for (let i = 1; i <= 25; i++) {
        codes.push((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'x' }, headers: { 'X-Forwarded-For': `192.168.2.${i}` } })).status);
      }
      assert.ok(codes.includes(429), 'il limite per account interviene');
      assert.equal(codes.filter((c) => c === 401).length, 20, '30 errori in totale, poi 429');
      // Anche la password giusta viene rifiutata finché il blocco è attivo.
      assert.equal((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'initialpass123' }, headers: { 'X-Forwarded-For': '192.168.3.1' } })).status, 429);
    } finally { await s.close(); }
  });
});

describe('Origin e Host: WebSocket admin e richieste di modifica', () => {
  test('WebSocket admin: Origin estraneo o assente rifiutato, stessa origine accettata; overlay pubblico invariato', async () => {
    const s = await serve();
    try {
      const { cookie } = await s.login();
      const base = { Cookie: cookie, 'User-Agent': UA };
      assert.equal((await wsStatus(s.port, '/ws/admin', { ...base, Origin: 'http://evil.example' })).status, 403);
      assert.equal((await wsStatus(s.port, '/ws/admin', { ...base, Origin: 'http://umbrel.local:9999' })).status, 403, 'altra app sullo stesso host');
      assert.equal((await wsStatus(s.port, '/ws/admin', base)).status, 403, 'Origin assente');
      assert.equal((await wsStatus(s.port, '/ws/admin', { ...base, Origin: 'null' })).status, 403);
      const ok = await wsStatus(s.port, '/ws/admin', { ...base, Origin: `http://127.0.0.1:${s.port}` });
      assert.equal(ok.status, 101);
      assert.equal(ok.first, 'snapshot');
      assert.equal((await wsStatus(s.port, '/ws/admin', { Origin: `http://127.0.0.1:${s.port}`, 'User-Agent': UA })).status, 401, 'senza cookie');
      // L'overlay deve continuare a funzionare da OBS e da qualsiasi origine.
      assert.equal((await wsStatus(s.port, '/ws/overlay', { Origin: 'http://evil.example' })).status, 101);
      assert.equal((await wsStatus(s.port, '/ws/overlay', {})).status, 101);
    } finally { await s.close(); }
  });

  test('ALLOWED_ORIGINS consente origini aggiuntive esplicite', async () => {
    const s = await serve({ env: { ALLOWED_ORIGINS: 'https://livecatch.example.lan' } });
    try {
      const { cookie } = await s.login();
      assert.equal((await wsStatus(s.port, '/ws/admin', { Cookie: cookie, 'User-Agent': UA, Origin: 'https://livecatch.example.lan' })).status, 101);
    } finally { await s.close(); }
  });

  test('richieste di modifica con Origin estraneo rifiutate anche con cookie e CSRF validi', async () => {
    const s = await serve();
    try {
      const { cookie, csrf } = await s.login();
      const evil = await s.call('POST', '/api/admin/backups', { cookie, csrf, headers: { Origin: 'http://umbrel.local:9999' } });
      assert.equal(evil.status, 403);
      const cross = await s.call('POST', '/api/admin/backups', { cookie, csrf, headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(cross.status, 403);
      const same = await s.call('POST', '/api/admin/backups', { cookie, csrf, headers: { Origin: `http://127.0.0.1:${s.port}` } });
      assert.equal(same.status, 200);
      assert.equal((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: NEWPW }, headers: { Origin: 'http://evil.example' } })).status, 403, 'login da un altro sito');
    } finally { await s.close(); }
  });
});

describe('Isolamento delle sessioni amministrative', () => {
  test('cookie riusato da un altro browser o da un altro indirizzo: rifiutato', async () => {
    const s = await serve({ env: { TRUSTED_PROXIES: '127.0.0.1' } });
    try {
      const pc = { 'X-Forwarded-For': '192.168.1.50' };
      const { cookie } = await s.login(pc);
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: pc })).status, 200);
      // Un'altra app sullo stesso server che ha ricevuto il cookie lo riusa dal proprio indirizzo.
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: { 'X-Forwarded-For': '10.21.0.42' } })).status, 401);
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie })).status, 401, 'indirizzo del proxy');
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: { ...pc, 'User-Agent': 'curl/8' } })).status, 401, 'browser diverso');
      // La sessione originale resta valida.
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: pc })).status, 200);
    } finally { await s.close(); }
  });

  test('il vincolo IP si può disattivare; la sessione scade per inattività', async () => {
    const s = await serve({ env: { TRUSTED_PROXIES: '127.0.0.1' } });
    try {
      const { cookie, csrf } = await s.login({ 'X-Forwarded-For': '192.168.1.50' });
      const r = await s.call('PUT', '/api/admin/security', { cookie, csrf, body: { bindSessionIp: false, idleTimeoutH: 2 }, headers: { 'X-Forwarded-For': '192.168.1.50' } });
      assert.equal(r.status, 200, r.text);
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: { 'X-Forwarded-For': '192.168.1.77' } })).status, 200, 'IP cambiato (DHCP) ammesso');
      s.app.db.run('UPDATE admin_sessions SET last_seen_at = ?', new Date(Date.now() - 3 * 3600e3).toISOString());
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie, headers: { 'X-Forwarded-For': '192.168.1.77' } })).status, 401, 'scaduta per inattività');
    } finally { await s.close(); }
  });

  test('cookie Secure solo se l\'HTTPS è dichiarato da un proxy fidato', async () => {
    const s = await serve({ env: { TRUSTED_PROXIES: '127.0.0.1' } });
    const t = await serve();
    try {
      const a = await s.login({ 'X-Forwarded-Proto': 'https' });
      assert.match(a.setCookie, /; Secure/);
      const b = await t.login({ 'X-Forwarded-Proto': 'https' });
      assert.doesNotMatch(b.setCookie, /Secure/, 'header inviato direttamente dal client: ignorato');
    } finally { await s.close(); await t.close(); }
  });

  test('hostname dedicato: dashboard, API, login e WebSocket solo su quel nome; altre sessioni chiuse', async () => {
    const s = await serve();
    try {
      const shared = { Host: `umbrel.local:${s.port}` };
      const dedicated = { Host: `livecatch.lan:${s.port}` };
      const other = await s.login(shared); // sessione creata sull'host condiviso
      const mine = await s.login(dedicated, NEWPW);

      // Non si può attivare un hostname diverso da quello in uso (evita di restare chiusi fuori).
      const bad = await s.call('PUT', '/api/admin/security', { cookie: other.cookie, csrf: other.csrf, headers: shared, body: { adminHosts: ['livecatch.lan'] } });
      assert.equal(bad.status, 400);
      assert.equal((await s.call('PUT', '/api/admin/security', { cookie: mine.cookie, csrf: mine.csrf, headers: dedicated, body: { adminHosts: ['http://x'] } })).status, 400);

      const ok = await s.call('PUT', '/api/admin/security', { cookie: mine.cookie, csrf: mine.csrf, headers: dedicated, body: { adminHosts: ['livecatch.lan'] } });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.data.closedSessions, 1);

      // Host condiviso: tutto l'admin è rifiutato, il login non crea alcun cookie.
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie: other.cookie, headers: shared })).status, 421);
      const lg = await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: NEWPW }, headers: shared });
      assert.equal(lg.status, 421);
      assert.equal(lg.headers['set-cookie'], undefined);
      assert.equal(lg.data.details.adminUrl, `http://livecatch.lan:${s.port}/admin/`);
      const page = await s.call('GET', '/admin/', { headers: shared });
      assert.equal(page.status, 421);
      assert.match(page.text, /livecatch\.lan/);
      assert.equal((await wsStatus(s.port, '/ws/admin', { ...shared, Cookie: mine.cookie, 'User-Agent': UA, Origin: `http://umbrel.local:${s.port}` })).status, 421);

      // Host dedicato: funziona; la vecchia sessione è stata chiusa.
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie: mine.cookie, headers: dedicated })).status, 200);
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie: other.cookie, headers: dedicated })).status, 401);
      assert.equal((await s.call('GET', '/admin/', { headers: dedicated })).status, 200);
      assert.equal((await wsStatus(s.port, '/ws/admin', { ...dedicated, Cookie: mine.cookie, 'User-Agent': UA, Origin: `http://livecatch.lan:${s.port}` })).status, 101);

      // Overlay e pagine pubbliche restano disponibili su qualsiasi host.
      assert.equal((await s.call('GET', '/overlay', { headers: shared })).status, 200);
      assert.equal((await s.call('GET', '/api/public/overlay', { headers: shared })).status, 200);
      assert.equal((await wsStatus(s.port, '/ws/overlay', shared)).status, 101);
    } finally { await s.close(); }
  });

  test('recupero accesso: il file reset-admin-password rimuove anche l\'hostname dedicato', async () => {
    const dir = tempDir();
    try {
      let { app } = await makeApp({ dir, configureTwitch: false });
      app.adminSettings.set('security', { ...app.adminSettings.get('security'), adminHosts: ['livecatch.lan'] });
      await app.close();
      writeFileSync(join(dir, 'reset-admin-password'), '');
      ({ app } = await makeApp({ dir, configureTwitch: false }));
      assert.deepEqual(app.adminSettings.get('security').adminHosts, []);
      assert.ok(existsSync(join(dir, 'initial-admin-password.txt')));
      await app.close();
    } finally { cleanup(dir); }
  });

  test('ADMIN_HOSTS da variabile d\'ambiente ha la precedenza e non è modificabile dalla dashboard', async () => {
    const s = await serve({ env: { ADMIN_HOSTS: 'livecatch.lan' } });
    try {
      const dedicated = { Host: `livecatch.lan:${s.port}` };
      assert.equal((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'initialpass123' } })).status, 421);
      const { cookie, csrf } = await s.login(dedicated);
      const r = await s.call('PUT', '/api/admin/security', { cookie, csrf, headers: dedicated, body: { adminHosts: [] } });
      assert.equal(r.status, 409);
    } finally { await s.close(); }
  });
});

describe('Aggiornamento da una versione precedente', () => {
  test('database v1 esistente: backup automatico, migrazione e dati conservati', async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'db'), { recursive: true });
      const old = new DatabaseSync(join(dir, 'db', 'livecatch.sqlite'));
      old.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))');
      old.exec(migrations[0].sql);
      old.prepare('INSERT INTO schema_migrations (id, name) VALUES (1, ?)').run(migrations[0].name);
      old.exec("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('2001', 'mario', 'Mario')");
      old.exec("INSERT INTO pokemon (dex_number, slug, name) VALUES (25, 'pikachu', 'Pikachu')");
      old.exec("INSERT INTO user_pokemon (user_id, pokemon_id, source) VALUES (1, 1, 'admin')");
      old.close();

      const { app } = await makeApp({ dir, configureTwitch: false });
      assert.equal(app.db.schemaVersion(), migrations.at(-1).id);
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1, 'collezioni conservate');
      assert.equal(app.db.get("SELECT login FROM twitch_users WHERE twitch_id = '2001'").login, 'mario');
      const pre = readdirSync(join(dir, 'backups')).filter((f) => f.includes('pre-migration'));
      assert.equal(pre.length, 1, 'backup prima della migrazione');
      assert.ok(app.backups.list().some((b) => b.kind === 'pre-migration' && b.exists));
      await app.close();
    } finally { cleanup(dir); }
  });
});
