// Archivio dei temi dell'overlay (tabella overlay_themes).
//
// - I preset integrati vengono creati/aggiornati all'avvio a partire da
//   theme-core.js. La loro configurazione modificata dall'utente resta salvata;
//   "Ripristina" la riporta ai valori del preset.
// - I temi personalizzati nascono da un duplicato, da un'importazione o da zero
//   (scegliendo lo stile grafico di base).
// - Il tema attivo è salvato in overlay_settings (chiave activeThemeId).
import {
  PRESETS, LAYOUTS, presetBySlug, defaultConfig, sanitizeConfig, sanitizeName, exportTheme, parseImport, effectiveSettings, legacyPatch, mergeConfig,
} from '../../public/assets/js/overlay/theme-core.js';
import { nowIso } from '../database/index.js';

export const MAX_CUSTOM_THEMES = 100;
const LEGACY_KEYS = ['layout', 'colors', 'animations', 'notifications', 'elements', 'font'];

export class ThemeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class ThemeStore {
  constructor({ db, overlaySettings, log }) {
    this.db = db;
    this.settings = overlaySettings;
    this.log = log;
  }

  init() {
    const fresh = !this.db.get('SELECT id FROM overlay_themes LIMIT 1');
    for (const p of PRESETS) {
      const original = JSON.stringify(p.config);
      const row = this.db.get('SELECT * FROM overlay_themes WHERE slug = ?', p.slug);
      if (!row) {
        this.db.run('INSERT INTO overlay_themes (slug, name, base, is_builtin, config, original_config) VALUES (?, ?, ?, 1, ?, ?)', p.slug, p.name, p.base, original, original);
      } else if (row.original_config !== original) {
        // Nuova versione del preset: aggiorna i valori originali; se l'utente non
        // l'aveva modificato, aggiorna anche la configurazione in uso.
        const untouched = row.config === row.original_config;
        this.db.run('UPDATE overlay_themes SET original_config = ?, config = CASE WHEN ? THEN ? ELSE config END, rev = rev + ? WHERE id = ?',
          original, untouched ? 1 : 0, original, untouched ? 1 : 0, row.id);
      }
    }
    if (fresh) this.importLegacySettings();
    if (!this.get(this.settings.get('activeThemeId'))) this.settings.set('activeThemeId', this.bySlug('classic').id);
  }

  // Le impostazioni dell'overlay delle versioni precedenti diventano le modifiche
  // del tema "Classico", che resta attivo: l'aspetto in OBS non cambia.
  importLegacySettings() {
    const keys = this.db.all('SELECT key FROM overlay_settings').map((r) => r.key).filter((k) => LEGACY_KEYS.includes(k));
    if (!keys.length) return;
    const classic = this.bySlug('classic');
    const { config } = sanitizeConfig(mergeConfig(classic.config, legacyPatch(this.settings.all())), classic.config);
    this.write(classic.id, { config });
    this.log?.info('Impostazioni overlay precedenti applicate al tema "Classico"');
  }

  row2theme(r) {
    if (!r) return null;
    const config = sanitizeConfig(safeParse(r.config), defaultConfig(r.base)).config;
    return {
      id: r.id, slug: r.slug, name: r.name, base: r.base, builtin: !!r.is_builtin, rev: r.rev,
      modified: r.config !== r.original_config, config, createdAt: r.created_at, updatedAt: r.updated_at,
      description: r.slug ? presetBySlug(r.slug)?.description || '' : '',
    };
  }

  get(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return this.row2theme(this.db.get('SELECT * FROM overlay_themes WHERE id = ?', n));
  }

  bySlug(slug) { return this.row2theme(this.db.get('SELECT * FROM overlay_themes WHERE slug = ?', slug)); }

  require(id) {
    const t = this.get(id);
    if (!t) throw new ThemeError(404, 'Tema non trovato');
    return t;
  }

  list() {
    return this.db.all('SELECT * FROM overlay_themes ORDER BY is_builtin DESC, id').map((r) => this.row2theme(r));
  }

  activeId() { return Number(this.settings.get('activeThemeId')) || null; }

  active() { return this.get(this.activeId()) || this.bySlug('classic'); }

  setActive(id) {
    const t = this.require(id);
    this.settings.set('activeThemeId', t.id);
    return t;
  }

  // `rev` (facoltativo): la scrittura avviene solo se il tema è ancora alla
  // revisione indicata, nella stessa istruzione SQL (nessuna finestra di gara).
  write(id, { name, config, rev }) {
    const sets = ['updated_at = ?', 'rev = rev + 1'];
    const args = [nowIso()];
    if (name !== undefined) { sets.push('name = ?'); args.push(name); }
    if (config !== undefined) { sets.push('config = ?'); args.push(JSON.stringify(config)); }
    let where = 'id = ?';
    args.push(id);
    if (rev !== undefined) { where += ' AND rev = ?'; args.push(rev); }
    const r = this.db.run(`UPDATE overlay_themes SET ${sets.join(', ')} WHERE ${where}`, ...args);
    if (rev !== undefined && Number(r.changes) === 0) throw this.conflict(id);
    return this.get(id);
  }

  conflict(id) {
    const current = this.get(id);
    const e = new ThemeError(409, `Il tema "${current?.name ?? id}" è stato modificato altrove (revisione ${current?.rev}): ricarica oppure sovrascrivi`);
    e.current = current;
    return e;
  }

  // Salva le modifiche. I preset integrati mantengono il nome originale.
  // Con `rev` le modifiche vengono rifiutate (409) se nel frattempo il tema è
  // stato salvato da un'altra scheda o da un'altra persona.
  update(id, { name, config, rev } = {}) {
    const t = this.require(id);
    if (rev !== undefined && (!Number.isInteger(rev) || rev < 0)) throw new ThemeError(400, 'Revisione non valida');
    if (rev !== undefined && rev !== t.rev) throw this.conflict(t.id);
    const out = { warnings: [] };
    let cfg;
    if (config !== undefined) {
      const r = sanitizeConfig(config, t.config);
      cfg = r.config;
      out.warnings = r.warnings;
    }
    const nm = name !== undefined && !t.builtin ? sanitizeName(name, t.name) : undefined;
    out.theme = this.write(t.id, { name: nm, config: cfg, rev });
    return out;
  }

  countCustom() { return this.db.get('SELECT COUNT(*) AS n FROM overlay_themes WHERE is_builtin = 0').n; }

  create({ name, base, config } = {}) {
    if (!Object.hasOwn(LAYOUTS, base)) throw new ThemeError(400, 'Stile grafico di base sconosciuto');
    if (this.countCustom() >= MAX_CUSTOM_THEMES) throw new ThemeError(409, `Hai raggiunto il limite di ${MAX_CUSTOM_THEMES} temi personalizzati: eliminane qualcuno`);
    const { config: cfg, warnings } = sanitizeConfig(config, defaultConfig(base));
    const json = JSON.stringify(cfg);
    const r = this.db.run('INSERT INTO overlay_themes (slug, name, base, is_builtin, config, original_config) VALUES (NULL, ?, ?, 0, ?, ?)',
      sanitizeName(name), base, json, json);
    return { theme: this.get(Number(r.lastInsertRowid)), warnings };
  }

  duplicate(id, name) {
    const t = this.require(id);
    return this.create({ name: sanitizeName(name, `${t.name} (copia)`), base: t.base, config: t.config }).theme;
  }

  // Preset integrato → valori del preset; tema personalizzato → valori con cui è stato creato.
  reset(id) {
    const t = this.require(id);
    const row = this.db.get('SELECT original_config FROM overlay_themes WHERE id = ?', t.id);
    return this.write(t.id, { config: sanitizeConfig(safeParse(row.original_config), defaultConfig(t.base)).config });
  }

  remove(id) {
    const t = this.require(id);
    if (t.builtin) throw new ThemeError(400, 'I preset integrati non si possono eliminare (puoi ripristinarli)');
    const wasActive = this.activeId() === t.id;
    this.db.run('DELETE FROM overlay_themes WHERE id = ?', t.id);
    if (wasActive) this.settings.set('activeThemeId', this.bySlug('classic').id);
    return { removed: t.id, activeChanged: wasActive };
  }

  exportJson(id) { return exportTheme(this.require(id)); }

  importJson(raw) {
    let parsed;
    try { parsed = parseImport(raw); } catch (e) { throw new ThemeError(400, e.message); }
    const { theme } = this.create(parsed);
    return { theme, warnings: parsed.warnings };
  }

  effective(theme = this.active()) {
    const l = this.settings.get('layout') || {};
    return effectiveSettings(theme, { width: l.width || 1920, height: l.height || 1080 });
  }

  // Vecchio PUT /api/admin/overlay: le modifiche vanno sul tema attivo.
  applyLegacy(body) {
    const t = this.active();
    return this.update(t.id, { config: mergeConfig(t.config, legacyPatch(body)) }).theme;
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return undefined; } }

