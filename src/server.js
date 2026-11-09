// Punto di ingresso del servizio.
import { loadConfig } from './config.js';
import { App } from './app.js';

const config = loadConfig();
const app = new App(config);

async function main() {
  await app.init();
  await app.listen();
  await app.startServices();
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.log?.info(`Arresto richiesto (${signal}): salvataggio in corso…`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try { await app.close(); } catch { /* ignora */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => app.log?.error('Promise non gestita', { message: e?.message || String(e) }));
process.on('uncaughtException', (e) => {
  app.log?.error('Eccezione non gestita', { message: e.message, stack: e.stack });
});

main().catch((e) => {
  console.error('Avvio fallito:', e);
  process.exit(1);
});
