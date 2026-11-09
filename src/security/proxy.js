// Fiducia nei reverse proxy. Gli header X-Forwarded-* vengono considerati SOLO
// se la connessione TCP proviene da un proxy esplicitamente autorizzato
// (variabile TRUSTED_PROXIES). In tutti gli altri casi l'IP del client è
// l'indirizzo reale del socket e gli header inoltrati vengono ignorati.
//
// Voci ammesse in TRUSTED_PROXIES (separate da virgola):
//   - un indirizzo IP (10.21.0.1, ::1)
//   - una rete CIDR (10.21.0.0/16)
//   - "loopback"        → 127.0.0.0/8 e ::1
//   - "docker-gateway"  → i gateway delle reti del container (letti da /proc/net/route):
//                         è l'indirizzo da cui il gateway app di umbrelOS (che gira
//                         sull'host) si collega al container
//   - un nome host      → risolto via DNS e aggiornato ogni minuto
//                         (es. piu-live-catch_app_proxy_1, il vecchio sidecar app_proxy)
import { BlockList, isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';

export function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  // Rimuove un'eventuale porta da un IPv4 (1.2.3.4:5678).
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.split(':')[0];
  return s;
}

// Gateway IPv4 delle rotte del container (formato di /proc/net/route, little-endian esadecimale).
export function readDockerGateways(file = '/proc/net/route') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = new Set();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const gw = cols[2];
    const flags = Number.parseInt(cols[3], 16);
    if (!/^[0-9A-Fa-f]{8}$/.test(gw) || gw === '00000000' || !(flags & 0x2)) continue;
    const n = Number.parseInt(gw, 16);
    out.add([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.'));
  }
  return [...out];
}

export class ProxyTrust {
  constructor({ spec = '', log = null, resolver = lookup, routeFile = '/proc/net/route' } = {}) {
    this.log = log;
    this.resolver = resolver;
    this.entries = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.static = new BlockList();
    this.hostnames = [];
    this.resolved = new Map(); // hostname -> [ip]
    this.description = [];
    for (const e of this.entries) this.addEntry(e, routeFile);
    this.timer = null;
  }

  get enabled() { return this.entries.length > 0; }

  addEntry(e, routeFile) {
    const lower = e.toLowerCase();
    if (lower === 'loopback') {
      this.static.addSubnet('127.0.0.0', 8, 'ipv4');
      this.static.addAddress('::1', 'ipv6');
      this.description.push('loopback');
      return;
    }
    if (lower === 'docker-gateway') {
      const gws = readDockerGateways(routeFile);
      for (const g of gws) this.static.addAddress(g, 'ipv4');
      this.description.push(`docker-gateway (${gws.join(', ') || 'nessun gateway trovato'})`);
      return;
    }
    const [addr, bits] = e.split('/');
    const fam = isIP(addr);
    if (fam && bits !== undefined) {
      const prefix = Number(bits);
      if (Number.isInteger(prefix) && prefix >= 0 && prefix <= (fam === 4 ? 32 : 128)) {
        this.static.addSubnet(addr, prefix, fam === 4 ? 'ipv4' : 'ipv6');
        this.description.push(e);
        return;
      }
    } else if (fam) {
      this.static.addAddress(addr, fam === 4 ? 'ipv4' : 'ipv6');
      this.description.push(e);
      return;
    }
    if (/^[a-z0-9][a-z0-9_.-]{0,253}$/i.test(e)) {
      this.hostnames.push(e);
      this.description.push(`${e} (DNS)`);
      return;
    }
    this.log?.warn(`TRUSTED_PROXIES: voce non valida ignorata: ${e}`);
  }

  async refresh() {
    for (const h of this.hostnames) {
      try {
        const list = await this.resolver(h, { all: true });
        this.resolved.set(h, list.map((x) => normalizeIp(x.address)));
      } catch {
        this.resolved.set(h, []);
      }
    }
  }

  async start() {
    if (!this.hostnames.length) return;
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), 60_000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  isTrusted(ip) {
    const a = normalizeIp(ip);
    const fam = isIP(a);
    if (!fam) return false;
    if (this.static.check(a, fam === 4 ? 'ipv4' : 'ipv6')) return true;
    for (const list of this.resolved.values()) if (list.includes(a)) return true;
    return false;
  }

  // IP reale del client. Se il peer è un proxy fidato si percorre X-Forwarded-For
  // da destra a sinistra saltando i proxy fidati: il primo indirizzo non fidato è
  // il client. Valori inseriti dal client a sinistra non vengono mai usati.
  clientIp(req) {
    const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
    if (!this.enabled || !this.isTrusted(peer)) return peer;
    const xff = req.headers['x-forwarded-for'];
    if (!xff) return peer;
    const hops = String(Array.isArray(xff) ? xff.join(',') : xff).split(',').map(normalizeIp).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isIP(hops[i])) return peer; // header malformato: non ci si fida
      if (!this.isTrusted(hops[i])) return hops[i];
    }
    return hops[0] || peer;
  }

  // Protocollo originale (per marcare i cookie Secure dietro HTTPS).
  isHttps(req) {
    if (req.socket?.encrypted) return true;
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (!this.enabled || !this.isTrusted(peer)) return false;
    return String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim().toLowerCase() === 'https';
  }

  info() {
    return { configured: this.enabled, entries: this.description, resolved: Object.fromEntries(this.resolved) };
  }
}
