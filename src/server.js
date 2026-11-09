// Punto di ingresso del servizio.
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { App } from './app.js';

const config = loadConfig();
let app = null;

// Verifica che la cartella dati sia scrivibile prima di avviare (volume Umbrel
// con proprietario sbagliato = errore chiaro invece di un crash a metà).
function checkDataDir(dir) {
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (e) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    const gid = typeof process.getgid === 'function' ? process.getgid() : '?';
    console.error(`ERRORE: la cartella dati ${dir} non è scrivibile dall'utente ${uid}:${gid} (${e.code || e.message}).`);
    console.error(`Su Umbrel/Docker il volume deve appartenere all'utente 1000:1000, ad esempio: sudo chown -R 1000:1000 <cartella-dati>`);
    process.exit(1);
  }
}

async function main() {
  checkDataDir(config.dataDir);
  app = new App(config);
  await app.init();
  await app.listen();
  await app.startServices();
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app?.log?.info(`Arresto richiesto (${signal}): salvataggio in corso…`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try { await app?.close(); } catch { /* ignora */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => app?.log?.error('Promise non gestita', { message: e?.message || String(e) }));
process.on('uncaughtException', (e) => {
  app?.log?.error('Eccezione non gestita', { message: e.message, stack: e.stack });
});

main().catch((e) => {
  console.error('Avvio fallito:', e);
  process.exit(1);
});
