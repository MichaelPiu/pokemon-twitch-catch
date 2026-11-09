// Validazione delle impostazioni ricevute dalla dashboard.
import { HttpError, v } from '../http/router.js';
import { RARITIES } from './defaults.js';

const num = (x, min, max, name, int = false) => v.num(x, { min, max, name, int });

function rarityMap(input, min, max, name) {
  const out = {};
  for (const r of RARITIES) out[r] = num(input?.[r], min, max, `${name} (${r})`);
  return out;
}

export function validateSpawn(s, cur) {
  const o = { ...cur, ...s };
  const res = {
    enabled: v.bool(o.enabled),
    minIntervalS: num(o.minIntervalS, 10, 86400, 'Intervallo minimo', true),
    maxIntervalS: num(o.maxIntervalS, 10, 86400, 'Intervallo massimo', true),
    durationS: num(o.durationS, 10, 3600, 'Durata spawn', true),
    spawnChance: num(o.spawnChance, 0, 1, 'Probabilità di spawn'),
    maxAttemptsPerSpawn: num(o.maxAttemptsPerSpawn, 0, 10000, 'Tentativi massimi per spawn', true),
    maxAttemptsPerUser: num(o.maxAttemptsPerUser, 0, 1000, 'Tentativi massimi per utente', true),
    firstSpawnDelayS: num(o.firstSpawnDelayS, 0, 86400, 'Ritardo primo spawn', true),
    allowedGenerations: Array.isArray(o.allowedGenerations) ? o.allowedGenerations.map((g) => num(g, 1, 20, 'Generazione', true)) : [],
    lateGraceS: num(o.lateGraceS, 0, 120, 'Tolleranza ritardo', true),
  };
  if (res.minIntervalS > res.maxIntervalS) throw new HttpError(400, "L'intervallo minimo non può superare il massimo");
  return res;
}

export function validateGame(body, store) {
  const out = {};
  if (body.spawn) out.spawn = validateSpawn(body.spawn, store.get('spawn'));
  if (body.rarityWeights) out.rarityWeights = rarityMap(body.rarityWeights, 0, 100000, 'Peso rarità');
  if (body.rarityCatchBase) out.rarityCatchBase = rarityMap(body.rarityCatchBase, 0, 1, 'Probabilità base');
  if (body.shiny) {
    const s = { ...store.get('shiny'), ...body.shiny };
    out.shiny = { enabled: v.bool(s.enabled), chance: num(s.chance, 0, 1, 'Probabilità shiny'), catchModifier: num(s.catchModifier, 0.01, 10, 'Modificatore shiny') };
  }
  if (body.capture) {
    const c = { ...store.get('capture'), ...body.capture };
    out.capture = {
      mode: v.oneOf(c.mode, ['single', 'multi'], 'Modalità cattura'),
      globalModifier: num(c.globalModifier, 0.01, 100, 'Modificatore globale'),
      masterBallEnabled: v.bool(c.masterBallEnabled),
      minChance: num(c.minChance, 0, 1, 'Probabilità minima'),
      maxChance: num(c.maxChance, 0, 1, 'Probabilità massima'),
      refundRejected: v.bool(c.refundRejected),
      fulfillProcessed: v.bool(c.fulfillProcessed),
      revokeOnCancel: v.bool(c.revokeOnCancel),
    };
    if (out.capture.minChance > out.capture.maxChance) throw new HttpError(400, 'La probabilità minima non può superare la massima');
  }
  if (body.event) {
    const e = { ...store.get('event'), ...body.event };
    out.event = {
      enabled: v.bool(e.enabled),
      name: v.str(e.name || 'Evento speciale', { max: 60, name: 'Nome evento' }),
      catchModifier: num(e.catchModifier, 0.01, 100, 'Modificatore cattura evento'),
      shinyMultiplier: num(e.shinyMultiplier, 0, 1000, 'Moltiplicatore shiny evento'),
      rarityBoost: rarityMap({ ...store.get('event').rarityBoost, ...e.rarityBoost }, 0, 1000, 'Boost rarità'),
      types: Array.isArray(e.types) ? e.types.map((t) => v.str(t, { max: 20, pattern: /^[a-z-]+$/, name: 'Tipo' })) : [],
    };
  }
  if (body.lifecycle) {
    const l = { ...store.get('lifecycle'), ...body.lifecycle };
    out.lifecycle = {
      pollIntervalS: num(l.pollIntervalS, 15, 3600, 'Intervallo controllo stato', true),
      offlineConfirmations: num(l.offlineConfirmations, 1, 10, 'Conferme offline', true),
    };
  }
  if (body.rewards) {
    const w = { ...store.get('rewards'), ...body.rewards };
    out.rewards = {
      autoPause: v.bool(w.autoPause),
      reconcileEnabled: v.bool(w.reconcileEnabled),
      reconcileIntervalS: num(w.reconcileIntervalS, 60, 3600, 'Intervallo recupero riscatti', true),
    };
  }
  return out;
}

export function validateCommandGlobals(body, cur) {
  const o = { ...cur, ...body };
  return {
    prefix: v.str(o.prefix, { min: 1, max: 3, name: 'Prefisso', pattern: /^[!#$%&*+.?~-]{1,3}$/ }),
    userMaxPerWindow: num(o.userMaxPerWindow, 1, 100, 'Comandi per utente', true),
    userWindowS: num(o.userWindowS, 1, 3600, 'Finestra anti-spam', true),
    botMaxPerWindow: num(o.botMaxPerWindow, 1, 100, 'Risposte bot', true),
    botWindowS: num(o.botWindowS, 1, 3600, 'Finestra bot', true),
    replyWhenOffline: false,
  };
}

export function validateOverlay(body, store) {
  const out = {};
  if (body.layout) {
    const l = { ...store.get('layout'), ...body.layout };
    out.layout = {
      position: v.oneOf(l.position, ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'top-center', 'bottom-center'], 'Posizione'),
      scale: num(l.scale, 0.3, 3, 'Scala'),
      width: num(l.width, 320, 7680, 'Larghezza', true),
      height: num(l.height, 240, 4320, 'Altezza', true),
      offsetX: num(l.offsetX, 0, 2000, 'Margine X', true),
      offsetY: num(l.offsetY, 0, 2000, 'Margine Y', true),
    };
  }
  if (body.colors) {
    const c = { ...store.get('colors'), ...body.colors };
    out.colors = {};
    for (const k of ['primary', 'accent', 'background', 'text', 'success', 'failure']) out.colors[k] = v.color(c[k], `Colore ${k}`);
  }
  if (body.animations) {
    const a = { ...store.get('animations'), ...body.animations };
    out.animations = { enabled: v.bool(a.enabled), speed: num(a.speed, 0.25, 4, 'Velocità animazioni') };
  }
  if (body.notifications) {
    const n = { ...store.get('notifications'), ...body.notifications };
    out.notifications = {
      durationMs: num(n.durationMs, 1000, 30000, 'Durata notifiche', true),
      maxQueue: num(n.maxQueue, 1, 100, 'Coda notifiche', true),
      showThrows: v.bool(n.showThrows),
      showFailures: v.bool(n.showFailures),
    };
  }
  if (body.elements) {
    const e = { ...store.get('elements'), ...body.elements };
    out.elements = {};
    for (const k of ['image', 'name', 'dexNumber', 'rarity', 'timer', 'attempts', 'types']) out.elements[k] = v.bool(e[k]);
  }
  if (body.font !== undefined) out.font = v.str(body.font, { max: 60, name: 'Font', pattern: /^[A-Za-z0-9 ,'-]+$/ });
  return out;
}
