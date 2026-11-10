// Valori predefiniti delle impostazioni. Tutti modificabili dalla dashboard.
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];

export const RARITY_LABELS = {
  common: 'Comune',
  uncommon: 'Non comune',
  rare: 'Raro',
  epic: 'Epico',
  legendary: 'Leggendario',
  mythical: 'Mitico',
};

export const GAME_DEFAULTS = {
  spawn: {
    enabled: true,
    minIntervalS: 240,
    maxIntervalS: 600,
    durationS: 90,
    spawnChance: 1.0, // probabilità che a ogni intervallo appaia davvero un Pokémon
    maxAttemptsPerSpawn: 0, // 0 = illimitati; raggiunto il limite il Pokémon fugge
    maxAttemptsPerUser: 3, // tentativi per utente sullo stesso spawn (0 = illimitati)
    firstSpawnDelayS: 60,
    allowedGenerations: [], // vuoto = tutte
    lateGraceS: 5, // tolleranza per eventi arrivati in ritardo
  },
  rarityWeights: { common: 55, uncommon: 25, rare: 12, epic: 5, legendary: 2, mythical: 1 },
  rarityCatchBase: { common: 0.6, uncommon: 0.45, rare: 0.3, epic: 0.2, legendary: 0.08, mythical: 0.05 },
  shiny: { enabled: true, chance: 0.01, catchModifier: 0.85 },
  capture: {
    mode: 'single', // 'single' = un solo vincitore, 'multi' = cattura multipla
    globalModifier: 1.0,
    masterBallEnabled: true,
    minChance: 0.01,
    maxChance: 0.95,
    refundRejected: true, // rimborsa (CANCELED) le riscossioni non valide, se la ricompensa è gestita dall'app
    fulfillProcessed: true, // segna come FULFILLED le riscossioni elaborate
    revokeOnCancel: false, // se un moderatore annulla una riscossione già catturata, rimuove il Pokémon
  },
  event: {
    enabled: false,
    name: 'Evento speciale',
    catchModifier: 1.25,
    shinyMultiplier: 2,
    rarityBoost: { common: 1, uncommon: 1, rare: 1.5, epic: 1.5, legendary: 2, mythical: 2 },
    types: [], // se valorizzato, solo Pokémon di questi tipi
  },
  lifecycle: {
    pollIntervalS: 60,
    offlineConfirmations: 2, // controlli API consecutivi "offline" prima di chiudere la diretta
  },
  rewards: {
    // Mette in pausa su Twitch le ricompense create dall'app quando il gioco non è
    // attivo (offline, disconnessione, errore) e le riattiva quando torna LIVE.
    autoPause: true,
    // Recupera i riscatti rimasti in coda (UNFULFILLED) dopo una disconnessione.
    reconcileEnabled: true,
    reconcileIntervalS: 300,
  },
};

// Effetti sonori per OBS (Browser Source /overlay/audio): vedi src/audio/audio.js.
export const AUDIO_DEFAULTS = {
  enabled: true,
  volume: 70, // 0-100
  spawnEnabled: true,
  captureEnabled: true,
  spawnMode: 'random', // random: a caso dalla lista (senza ripetere l'ultimo) · fixed: sempre lo stesso file
  spawnFiles: null, // null = riconoscimento automatico per nome; altrimenti percorsi relativi
  spawnFixed: null,
  captureFile: null, // null = riconoscimento automatico per nome
  includeDemo: false, // suoni anche durante la modalità DEMO
  maxDurationS: 10, // taglio con dissolvenza (0 = brano intero)
};

export const ADMIN_DEFAULTS = {
  publicPages: { landing: true, pokedex: true, leaderboard: true },
  backup: { autoEnabled: true, hour: 4, keep: 14 },
  // Backup sulla cartella di rete (vedi src/backup/network.js, NETWORK_DEFAULTS).
  networkBackup: { enabled: false, subdir: 'livecatch', frequency: 'daily', hour: 3, keep: 14, beforeUpdate: true },
  twitch: { channelLogin: '', useSeparateBot: false },
  demo: { enabled: false },
  audio: { ...AUDIO_DEFAULTS },
  security: {
    adminHosts: [], // hostname dedicati alla dashboard (vuoto = qualsiasi host)
    bindSessionIp: true, // la sessione vale solo dall'indirizzo IP del login
    idleTimeoutH: 12, // chiusura della sessione dopo N ore di inattività
  },
};

export const OVERLAY_DEFAULTS = {
  layout: { position: 'bottom-right', scale: 1, width: 1920, height: 1080, offsetX: 40, offsetY: 40 },
  colors: {
    primary: '#e3350d',
    accent: '#ffcb05',
    background: 'rgba(16, 18, 32, 0.82)',
    text: '#ffffff',
    success: '#3ddc84',
    failure: '#ff5b5b',
  },
  animations: { enabled: true, speed: 1 },
  notifications: { durationMs: 4500, maxQueue: 20, showThrows: true, showFailures: true },
  elements: { image: true, name: true, dexNumber: true, rarity: true, timer: true, attempts: true, types: true },
  font: 'Fredoka',
};

export const DEFAULT_COMMANDS = [
  {
    command: 'pokedex',
    aliases: [],
    response: '@{user} hai catturato {total} Pokémon e scoperto {species} specie! ({shiny} shiny)',
    response_empty: '@{user} il tuo Pokédex è ancora vuoto: lancia una Poké Ball con i punti canale!',
    global_cooldown_s: 3,
    user_cooldown_s: 30,
    options: {},
  },
  {
    command: 'pokemon',
    aliases: [],
    response: '@{user} possiedi {total} Pokémon in totale.',
    response_empty: '@{user} non possiedi ancora nessun Pokémon.',
    global_cooldown_s: 3,
    user_cooldown_s: 30,
    options: {},
  },
  {
    command: 'dex',
    aliases: [],
    response: '@{user} {target} ha catturato {total} Pokémon e scoperto {species} specie!',
    response_empty: '@{user} {target} non ha ancora catturato Pokémon.',
    global_cooldown_s: 5,
    user_cooldown_s: 30,
    options: { allowOthers: true },
  },
  {
    command: 'ultimocatturato',
    aliases: ['ultimo'],
    response: '@{user} il tuo ultimo Pokémon catturato è {pokemon}{shinyTag} ({ball}, {when}).',
    response_empty: '@{user} non hai ancora catturato nessun Pokémon.',
    global_cooldown_s: 3,
    user_cooldown_s: 30,
    options: {},
  },
  {
    command: 'classifica',
    aliases: ['top'],
    response: 'Classifica Allenatori: {top}',
    response_empty: 'La classifica è ancora vuota!',
    global_cooldown_s: 30,
    user_cooldown_s: 60,
    options: { size: 5 },
  },
  {
    // Riservato a broadcaster e moderatori autorizzati (vedi Classifiche → Comandi).
    command: 'leaderboard',
    aliases: [],
    response: 'Classifica della diretta sullo schermo!',
    response_empty: null,
    global_cooldown_s: 3,
    user_cooldown_s: 3,
    options: {},
  },
  {
    command: 'help',
    aliases: ['comandi'],
    response: 'Comandi disponibili: {commands} — Usa i punti canale per lanciare le Poké Ball!',
    response_empty: null,
    global_cooldown_s: 15,
    user_cooldown_s: 60,
    options: {},
  },
];

export const COMMAND_GLOBAL_DEFAULTS = {
  prefix: '!',
  // Anti-spam per utente: massimo N comandi in una finestra di W secondi.
  userMaxPerWindow: 3,
  userWindowS: 60,
  // Limite risposte del bot (Twitch limita gli account non moderatori a ~20 messaggi / 30s).
  botMaxPerWindow: 15,
  botWindowS: 30,
  replyWhenOffline: false,
};

export const DEFAULT_BALLS = [
  { code: 'pokeball', name: 'Poké Ball', multiplier: 1.0, guaranteed: 0, color: '#e3350d', sort_order: 1 },
  { code: 'megaball', name: 'Mega Ball', multiplier: 1.5, guaranteed: 0, color: '#3b6fd8', sort_order: 2 },
  { code: 'ultraball', name: 'Ultra Ball', multiplier: 2.0, guaranteed: 0, color: '#f2c200', sort_order: 3 },
  { code: 'masterball', name: 'Master Ball', multiplier: 1.0, guaranteed: 1, color: '#8a3fd1', sort_order: 4 },
];

// Scope OAuth richiesti (documentati anche nel README).
export const BROADCASTER_SCOPES = [
  'channel:read:redemptions',
  'channel:manage:redemptions',
  'user:read:chat',
  'user:write:chat',
];
export const BOT_SCOPES = ['user:write:chat'];
