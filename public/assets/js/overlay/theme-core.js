// Overlay Themes: definizione dei preset, schema della configurazione,
// validazione/sanificazione e conversione nelle impostazioni lette dall'overlay.
//
// Modulo condiviso (nessuna dipendenza): usato dal server (salvataggio,
// importazione, API) e dal browser (anteprima immediata nell'Overlay Designer).
// La validazione del server è quella che conta; nel browser serve solo a
// mostrare subito l'anteprima con gli stessi valori che verranno salvati.

export const THEME_FORMAT = 'livecatch-overlay-theme';
export const THEME_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 64 * 1024;

// Famiglie grafiche: ognuna ha markup e foglio di stile propri
// (public/assets/css/themes/<id>.css), non solo colori diversi.
export const LAYOUTS = {
  classic: 'Classico (card centrata)',
  'minimal-dark': 'Minimal Dark (barra compatta)',
  'clean-glass': 'Clean Glass (vetro smerigliato)',
  'neon-hud': 'Neon HUD (interfaccia sci-fi)',
  'minimal-light': 'Minimal Light (editoriale chiaro)',
  'cyber-pulse': 'Cyber Pulse (pannelli inclinati, glitch)',
  holographic: 'Holographic (carta olografica)',
  cinematic: 'Cinematic (sottopancia panoramico)',
  'gradient-motion': 'Gradient Motion (gradienti animati)',
};

// Font: famiglie di sistema (nessun download esterno, compatibile con la CSP e
// con OBS offline). "custom" usa un font installato sul PC che esegue OBS.
export const FONTS = {
  rounded: ['Arrotondato', "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Segoe UI', system-ui, sans-serif"],
  system: ['Sistema (sans-serif)', "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"],
  geometric: ['Geometrico', "'Avenir Next', 'Montserrat', 'Century Gothic', 'Futura', 'Segoe UI', sans-serif"],
  condensed: ['Condensato', "'Bahnschrift SemiCondensed', 'Roboto Condensed', 'Arial Narrow', 'Helvetica Neue', sans-serif"],
  serif: ['Serif editoriale', "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif"],
  mono: ['Monospazio', "ui-monospace, 'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace"],
  display: ['Display (impatto)', "'Impact', 'Haettenschweiler', 'Arial Black', 'Franklin Gothic Heavy', sans-serif"],
  custom: ['Personalizzato (installato sul PC di OBS)', ''],
};

export const POSITIONS = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];
export const ENTRANCES = ['pop', 'fade', 'slide', 'rise', 'zoom', 'flip', 'glitch', 'wipe'];
export const EXITS = ['fade', 'shrink', 'slide', 'glitch', 'wipe'];
export const TIMER_STYLES = ['bar', 'ring', 'digits'];

// Configurazione di riferimento: ogni preset la completa con i propri valori.
const BASE = {
  colors: {
    primary: '#e3350d', secondary: '#ffcb05', background: 'transparent', panel: 'rgba(16, 18, 32, 0.82)',
    text: '#ffffff', muted: '#b9bfd3', success: '#3ddc84', failure: '#ff5b5b',
  },
  typography: { font: 'rounded', customFont: '', baseSize: 16, titleSize: 26, weight: 800, uppercase: false, letterSpacing: 0 },
  shape: { radius: 22, borderWidth: 3, shadow: 60, glow: 35 },
  layout: { position: 'bottom-right', offsetX: 40, offsetY: 40, panelWidth: 300, imageSize: 170, scale: 1 },
  animation: { enabled: true, entrance: 'pop', exit: 'shrink', speed: 1, idle: true, queueLimit: 6 },
  notifications: { durationMs: 4500, maxVisible: 3, maxQueue: 20, showThrows: true, showFailures: true, showCatches: true, showFlee: true },
  elements: { header: true, image: true, name: true, dexNumber: true, rarity: true, types: true, timer: true, timerStyle: 'bar', attempts: true, rarityColors: true },
  effects: { intensity: 60, particles: true, scanlines: false, shimmer: true },
};

// Unione a due livelli (gruppo → campo), usata dai preset e dal server.
export function mergeConfig(a, b) {
  const out = structuredClone(a);
  for (const [k, val] of Object.entries(b || {})) out[k] = val && typeof val === 'object' && !Array.isArray(val) ? { ...(out[k] || {}), ...val } : val;
  return out;
}
const merge = mergeConfig;

// Preset iniziali. "classic" riproduce l'aspetto delle versioni precedenti ed è
// il tema attivo di default, così l'aggiornamento non cambia l'overlay in diretta.
export const PRESETS = [
  { slug: 'classic', name: 'Classico', base: 'classic', description: 'L\'aspetto originale di Live Catch: card centrata con bordo del colore della rarità.', config: {} },
  {
    slug: 'minimal-dark', name: 'Minimal Dark', base: 'minimal-dark',
    description: 'Barra orizzontale compatta, nessun ornamento, linea del tempo sottile.',
    config: {
      colors: { primary: '#f5f5f7', secondary: '#8e8e93', panel: 'rgba(12, 12, 14, 0.88)', text: '#f5f5f7', muted: '#a1a1a6', success: '#30d158', failure: '#ff453a' },
      typography: { font: 'system', baseSize: 15, titleSize: 22, weight: 600, letterSpacing: 0.01 },
      shape: { radius: 12, borderWidth: 1, shadow: 40, glow: 0 },
      layout: { panelWidth: 380, imageSize: 84 },
      animation: { entrance: 'slide', exit: 'slide', idle: false },
      elements: { header: false, types: false, timerStyle: 'bar', rarityColors: false },
      effects: { intensity: 20, particles: false, shimmer: false },
    },
  },
  {
    slug: 'clean-glass', name: 'Clean Glass', base: 'clean-glass',
    description: 'Vetro smerigliato con riflessi morbidi; il Pokémon fluttua sopra la card.',
    config: {
      colors: { primary: '#ffffff', secondary: '#9be7ff', panel: 'rgba(18, 28, 48, 0.72)', text: '#ffffff', muted: '#e6f2ff', success: '#7cf3c0', failure: '#ff9aa8' },
      typography: { font: 'geometric', baseSize: 15, titleSize: 28, weight: 600 },
      shape: { radius: 28, borderWidth: 1, shadow: 45, glow: 20 },
      layout: { panelWidth: 320, imageSize: 180 },
      animation: { entrance: 'rise', exit: 'fade' },
      elements: { timerStyle: 'bar' },
      effects: { intensity: 50, particles: true, shimmer: true },
    },
  },
  {
    slug: 'neon-hud', name: 'Neon HUD', base: 'neon-hud',
    description: 'Interfaccia sci-fi: angoli tagliati, staffe di mira, timer circolare al neon.',
    config: {
      colors: { primary: '#00f0ff', secondary: '#ff2bd6', panel: 'rgba(3, 10, 24, 0.86)', text: '#d9fbff', muted: '#6fb7c4', success: '#39ff88', failure: '#ff3b5c' },
      typography: { font: 'mono', baseSize: 14, titleSize: 24, weight: 700, uppercase: true, letterSpacing: 0.12 },
      shape: { radius: 0, borderWidth: 2, shadow: 30, glow: 80 },
      layout: { panelWidth: 340, imageSize: 150 },
      animation: { entrance: 'wipe', exit: 'glitch' },
      elements: { timerStyle: 'ring' },
      effects: { intensity: 75, particles: false, scanlines: true, shimmer: false },
    },
  },
  {
    slug: 'minimal-light', name: 'Minimal Light', base: 'minimal-light',
    description: 'Stile editoriale chiaro: carta bianca, titolo serif, filetti sottili.',
    config: {
      colors: { primary: '#111111', secondary: '#c8102e', panel: 'rgba(255, 255, 255, 0.96)', text: '#111111', muted: '#6b6b6b', success: '#1a7f37', failure: '#c8102e' },
      typography: { font: 'serif', baseSize: 15, titleSize: 30, weight: 600, letterSpacing: 0 },
      shape: { radius: 4, borderWidth: 1, shadow: 25, glow: 0 },
      layout: { panelWidth: 300, imageSize: 150 },
      animation: { entrance: 'slide', exit: 'fade', idle: false },
      elements: { timerStyle: 'digits', rarityColors: false },
      effects: { intensity: 15, particles: false, shimmer: false },
    },
  },
  {
    slug: 'cyber-pulse', name: 'Cyber Pulse', base: 'cyber-pulse',
    description: 'Pannelli inclinati, testo glitch, bordo pulsante e grande conto alla rovescia.',
    config: {
      colors: { primary: '#ff0080', secondary: '#00e5ff', panel: 'rgba(18, 0, 30, 0.9)', text: '#ffffff', muted: '#c79bff', success: '#00ff9c', failure: '#ff3355' },
      typography: { font: 'condensed', baseSize: 16, titleSize: 34, weight: 800, uppercase: true, letterSpacing: 0.06 },
      shape: { radius: 2, borderWidth: 3, shadow: 50, glow: 70 },
      layout: { panelWidth: 360, imageSize: 150 },
      animation: { entrance: 'glitch', exit: 'glitch', speed: 1.1 },
      elements: { timerStyle: 'digits' },
      effects: { intensity: 80, particles: true, scanlines: true, shimmer: false },
    },
  },
  {
    slug: 'holographic', name: 'Holographic', base: 'holographic',
    description: 'Carta collezionabile verticale con bordo iridescente e riflesso olografico.',
    config: {
      colors: { primary: '#a78bfa', secondary: '#5eead4', panel: 'rgba(20, 16, 40, 0.88)', text: '#ffffff', muted: '#d6ccff', success: '#5eead4', failure: '#fb7185' },
      typography: { font: 'geometric', baseSize: 15, titleSize: 26, weight: 700 },
      shape: { radius: 18, borderWidth: 4, shadow: 55, glow: 55 },
      layout: { panelWidth: 280, imageSize: 180 },
      animation: { entrance: 'flip', exit: 'shrink' },
      elements: { timerStyle: 'bar' },
      effects: { intensity: 70, particles: true, shimmer: true },
    },
  },
  {
    slug: 'cinematic', name: 'Cinematic', base: 'cinematic',
    description: 'Sottopancia panoramico a tutta larghezza, titoli spaziati, filetto oro.',
    config: {
      colors: { primary: '#d4af37', secondary: '#f3e5ab', panel: 'rgba(0, 0, 0, 0.78)', text: '#f8f5ec', muted: '#b8b2a0', success: '#d4af37', failure: '#c0392b' },
      typography: { font: 'serif', baseSize: 17, titleSize: 40, weight: 500, uppercase: true, letterSpacing: 0.22 },
      shape: { radius: 0, borderWidth: 0, shadow: 20, glow: 0 },
      layout: { position: 'bottom-center', offsetX: 0, offsetY: 60, panelWidth: 1100, imageSize: 130 },
      animation: { entrance: 'fade', exit: 'fade', speed: 0.7, idle: false },
      notifications: { durationMs: 5500, maxVisible: 2 },
      elements: { header: true, types: false, timerStyle: 'bar' },
      effects: { intensity: 30, particles: false, shimmer: false },
    },
  },
  {
    slug: 'gradient-motion', name: 'Gradient Motion', base: 'gradient-motion',
    description: 'Gradienti fluidi in movimento, forme morbide ed entrate elastiche.',
    config: {
      colors: { primary: '#ff6a88', secondary: '#7b61ff', panel: 'rgba(30, 20, 60, 0.66)', text: '#ffffff', muted: '#f2e9ff', success: '#5cffc8', failure: '#ff8a8a' },
      typography: { font: 'rounded', baseSize: 16, titleSize: 30, weight: 800 },
      shape: { radius: 32, borderWidth: 0, shadow: 50, glow: 45 },
      layout: { panelWidth: 320, imageSize: 170 },
      animation: { entrance: 'zoom', exit: 'shrink', speed: 1 },
      elements: { timerStyle: 'ring' },
      effects: { intensity: 65, particles: true, shimmer: true },
    },
  },
].map((p) => ({ ...p, config: merge(BASE, p.config) }));

export const presetBySlug = (slug) => PRESETS.find((p) => p.slug === slug) || null;
export const defaultConfig = (base) => structuredClone((presetBySlug(base) || PRESETS[0]).config);

// --- Validazione -------------------------------------------------------------
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d{1,3}|1\.0+)\s*)?\)$/i;
// Nomi di font personalizzati: lettere (anche accentate), cifre, spazi, trattini e
// punti. Niente apici, virgolette, virgole o punti e virgola: il nome finisce in CSS.
const FONT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,59}$/u;

export function validColor(c) {
  if (typeof c !== 'string') return false;
  const s = c.trim();
  if (s === 'transparent' || HEX.test(s)) return true;
  const m = RGB.exec(s);
  return !!m && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
}

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// Campi ammessi: [tipo, min|valori, max]. Tutto ciò che non è elencato viene scartato.
const SCHEMA = {
  colors: Object.fromEntries(Object.keys(BASE.colors).map((k) => [k, ['color']])),
  typography: {
    font: ['enum', Object.keys(FONTS)], customFont: ['font'], baseSize: ['num', 10, 32], titleSize: ['num', 12, 72],
    weight: ['int', 300, 900], uppercase: ['bool'], letterSpacing: ['num', 0, 0.5],
  },
  shape: { radius: ['int', 0, 48], borderWidth: ['int', 0, 12], shadow: ['int', 0, 100], glow: ['int', 0, 100] },
  layout: {
    position: ['enum', POSITIONS], offsetX: ['int', 0, 1800], offsetY: ['int', 0, 1000],
    panelWidth: ['int', 200, 1700], imageSize: ['int', 48, 320], scale: ['num', 0.3, 3],
  },
  animation: { enabled: ['bool'], entrance: ['enum', ENTRANCES], exit: ['enum', EXITS], speed: ['num', 0.25, 4], idle: ['bool'], queueLimit: ['int', 2, 50] },
  notifications: {
    durationMs: ['int', 1000, 30000], maxVisible: ['int', 1, 6], maxQueue: ['int', 1, 100],
    showThrows: ['bool'], showFailures: ['bool'], showCatches: ['bool'], showFlee: ['bool'],
  },
  elements: {
    header: ['bool'], image: ['bool'], name: ['bool'], dexNumber: ['bool'], rarity: ['bool'], types: ['bool'],
    timer: ['bool'], timerStyle: ['enum', TIMER_STYLES], attempts: ['bool'], rarityColors: ['bool'],
  },
  effects: { intensity: ['int', 0, 100], particles: ['bool'], scanlines: ['bool'], shimmer: ['bool'] },
};

function coerce(spec, val) {
  const [type, a, b] = spec;
  switch (type) {
    case 'color': return validColor(val) ? val.trim() : undefined;
    case 'bool': return typeof val === 'boolean' ? val : undefined;
    case 'enum': return a.includes(val) ? val : undefined;
    case 'font': {
      if (val === '') return '';
      if (typeof val !== 'string') return undefined;
      const f = val.trim().replace(/\s+/g, ' ');
      return FONT_NAME.test(f) ? f : undefined;
    }
    case 'num':
    case 'int': {
      const n = typeof val === 'number' ? val : (typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN);
      if (!Number.isFinite(n)) return undefined;
      const c = Math.min(b, Math.max(a, n));
      return type === 'int' ? Math.round(c) : Math.round(c * 1000) / 1000;
    }
    default: return undefined;
  }
}

// Restituisce sempre una configurazione completa e valida: i valori mancanti o
// non validi vengono presi da `fallback`. `warnings` elenca ciò che è stato
// scartato o corretto (mostrato all'utente in caso di importazione).
export function sanitizeConfig(input, fallback = BASE) {
  const config = structuredClone(merge(BASE, fallback));
  const warnings = [];
  if (!isObj(input)) return { config, warnings: input === undefined ? [] : ['configurazione non valida: usati i valori predefiniti'] };
  for (const [group, fields] of Object.entries(SCHEMA)) {
    const src = input[group];
    if (src === undefined) continue;
    if (!isObj(src)) { warnings.push(`${group}: ignorato (non è un oggetto)`); continue; }
    for (const [key, spec] of Object.entries(fields)) {
      if (!Object.hasOwn(src, key)) continue;
      const v = coerce(spec, src[key]);
      if (v === undefined) warnings.push(`${group}.${key}: valore non valido ignorato`);
      else {
        if ((spec[0] === 'num' || spec[0] === 'int') && v !== Number(src[key])) warnings.push(`${group}.${key}: portato nell'intervallo consentito (${v})`);
        config[group][key] = v;
      }
    }
    for (const key of Object.keys(src)) if (!fields[key]) warnings.push(`${group}.${key}: campo sconosciuto ignorato`);
  }
  for (const key of Object.keys(input)) if (!SCHEMA[key]) warnings.push(`${key}: campo sconosciuto ignorato`);
  if (config.typography.font === 'custom' && !config.typography.customFont) config.typography.font = fallback?.typography?.font && fallback.typography.font !== 'custom' ? fallback.typography.font : 'system';
  return { config, warnings };
}

const NAME_RE = /[\u0000-\u001f\u007f<>]/g;
export function sanitizeName(name, fallback = 'Tema personalizzato') {
  const s = typeof name === 'string' ? name.replace(NAME_RE, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return s || fallback;
}

export function fontStack(typo) {
  // Il nome viene comunque ripulito e messo tra virgolette doppie: anche un valore
  // arrivato senza passare dalla validazione non può rompere la regola CSS.
  if (typo.font === 'custom' && typo.customFont) {
    const name = String(typo.customFont).replace(/[^\p{L}\p{N} .-]/gu, '').trim().slice(0, 60);
    if (name) return `"${name}", ${FONTS.system[1]}`;
  }
  return (FONTS[typo.font] || FONTS.system)[1];
}

// --- Esportazione / importazione ------------------------------------------------
export function exportTheme(theme) {
  return { format: THEME_FORMAT, version: THEME_FORMAT_VERSION, theme: { name: theme.name, base: theme.base, config: theme.config } };
}

// Accetta il testo o l'oggetto di un file esportato. Lancia un Error con un
// messaggio comprensibile se il file non è un preset valido.
export function parseImport(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_IMPORT_BYTES) throw new Error(`File troppo grande (massimo ${MAX_IMPORT_BYTES / 1024} KB)`);
    try { data = JSON.parse(raw); } catch { throw new Error('Il file non contiene JSON valido'); }
  }
  if (!isObj(data)) throw new Error('Formato non riconosciuto');
  if (data.format !== THEME_FORMAT) throw new Error(`Formato non riconosciuto: atteso "${THEME_FORMAT}"`);
  if (typeof data.version !== 'number' || data.version > THEME_FORMAT_VERSION) throw new Error('Versione del preset non supportata da questa versione di Live Catch');
  const t = data.theme;
  if (!isObj(t)) throw new Error('Il file non contiene un tema');
  const base = Object.hasOwn(LAYOUTS, t.base) ? t.base : null;
  if (!base) throw new Error('Stile grafico (base) sconosciuto');
  const { config, warnings } = sanitizeConfig(t.config, defaultConfig(base));
  return { name: sanitizeName(t.name, 'Tema importato'), base, config, warnings };
}

// --- Impostazioni per l'overlay ----------------------------------------------------
// Mantiene i campi letti dalle versioni precedenti dell'overlay (layout, colors,
// animations, notifications, elements, font) e aggiunge il tema completo.
export function effectiveSettings(theme, { width = 1920, height = 1080 } = {}) {
  const c = theme.config;
  return {
    layout: { position: c.layout.position, scale: c.layout.scale, width, height, offsetX: c.layout.offsetX, offsetY: c.layout.offsetY },
    colors: { primary: c.colors.primary, accent: c.colors.secondary, background: c.colors.panel, text: c.colors.text, success: c.colors.success, failure: c.colors.failure },
    animations: { enabled: c.animation.enabled, speed: c.animation.speed },
    notifications: { durationMs: c.notifications.durationMs, maxQueue: c.notifications.maxQueue, showThrows: c.notifications.showThrows, showFailures: c.notifications.showFailures },
    elements: { image: c.elements.image, name: c.elements.name, dexNumber: c.elements.dexNumber, rarity: c.elements.rarity, timer: c.elements.timer, attempts: c.elements.attempts, types: c.elements.types },
    font: c.typography.font === 'custom' ? c.typography.customFont : c.typography.font,
    theme: { id: theme.id ?? null, slug: theme.slug ?? null, name: theme.name, base: theme.base, rev: theme.rev ?? 0, config: c },
  };
}

// Modifica nel vecchio formato (PUT /api/admin/overlay) → patch della configurazione del tema.
export function legacyPatch(body) {
  const p = {};
  if (isObj(body.layout)) p.layout = { position: body.layout.position === 'center' || POSITIONS.includes(body.layout.position) ? body.layout.position : undefined, scale: body.layout.scale, offsetX: body.layout.offsetX, offsetY: body.layout.offsetY };
  if (isObj(body.colors)) p.colors = { primary: body.colors.primary, secondary: body.colors.accent, panel: body.colors.background, text: body.colors.text, success: body.colors.success, failure: body.colors.failure };
  if (isObj(body.animations)) p.animation = { enabled: body.animations.enabled, speed: body.animations.speed };
  if (isObj(body.notifications)) p.notifications = { ...body.notifications };
  if (isObj(body.elements)) p.elements = { ...body.elements };
  if (typeof body.font === 'string') p.typography = FONTS[body.font] ? { font: body.font } : { font: 'custom', customFont: body.font };
  for (const g of Object.values(p)) for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k];
  return p;
}
