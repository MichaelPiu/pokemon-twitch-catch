// Legge il risultato JSON del linter ufficiale di Umbrel e decide l'esito della CI.
// Nel repository di sviluppo l'immagine del pacchetto può non essere ancora fissata
// per digest (il digest esiste solo dopo la build del rilascio): la regola
// image.pinned è declassata ad avviso qui ed è invece OBBLIGATORIA nel repository
// pubblico dell'App Store (dove il linter gira anche con --check-images).
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'umbrel-lint.json';
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Impossibile leggere il risultato del linter (${file}): ${e.message}`);
  process.exit(1);
}
const DEV_ONLY_WARNINGS = new Set(['image.pinned']);
let errors = 0;
for (const i of report.issues || []) {
  const sev = i.severity === 'error' && DEV_ONLY_WARNINGS.has(i.rule) ? 'warning' : i.severity;
  if (sev === 'error') errors++;
  const where = `${i.file || ''}${i.line ? `:${i.line}` : ''}`;
  console.log(`${sev === 'error' ? '::error' : '::warning'} file=${i.file || ''},line=${i.line || 1}::[${i.rule}] ${i.message}`);
  console.log(`${sev.toUpperCase()} ${i.rule} ${where} — ${i.message}`);
}
console.log(`App controllate: ${(report.apps || []).join(', ') || 'nessuna'} · problemi: ${(report.issues || []).length} · errori bloccanti: ${errors}`);
if (!(report.apps || []).length) process.exit(1);
process.exit(errors ? 1 : 0);
