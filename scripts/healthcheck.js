// Usato da Docker HEALTHCHECK: esce con 0 se /health risponde "ok".
const port = process.env.PORT || 8080;
fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
