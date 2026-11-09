// Importazione dei dati da PokéAPI (https://pokeapi.co) con salvataggio locale.
// Dopo l'importazione il gioco funziona senza contattare PokéAPI.
// Le immagini vengono salvate in DATA_DIR/images.
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export function rarityFromSpecies(sp) {
  if (sp.is_mythical) return 'mythical';
  if (sp.is_legendary) return 'legendary';
  const cr = sp.capture_rate ?? 45;
  if (cr >= 150) return 'common';
  if (cr >= 75) return 'uncommon';
  if (cr >= 45) return 'rare';
  return 'epic';
}

function genNumber(url) {
  const m = /generation\/(\d+)/.exec(url || '');
  return m ? Number(m[1]) : null;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
function genFromName(name) {
  const m = /generation-([ivx]+)/.exec(name || '');
  return m ? ROMAN[m[1]] ?? null : null;
}

async function pool(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export class PokemonImporter extends EventEmitter {
  constructor({ db, config, log, fetchImpl = fetch }) {
    super();
    this.db = db;
    this.base = config.pokeapiBase;
    this.imagesDir = config.imagesDir;
    this.log = log;
    this.fetch = fetchImpl;
    this.progress = { running: false, phase: 'idle', done: 0, total: 0, errors: 0, startedAt: null, finishedAt: null, message: null };
    this.cancelled = false;
  }

  async json(url, tries = 3) {
    for (let a = 1; ; a++) {
      try {
        const res = await this.fetch(url, { headers: { 'User-Agent': 'live-catch-selfhosted' } });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (a >= tries) throw e;
        await new Promise((r) => setTimeout(r, 500 * a));
      }
    }
  }

  async download(url, file) {
    if (!url) return null;
    const path = join(this.imagesDir, file);
    if (existsSync(path)) return file;
    try {
      const res = await this.fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 || buf.length > 5 * 1024 * 1024) return null;
      writeFileSync(path, buf);
      return file;
    } catch {
      return null;
    }
  }

  update(p) {
    Object.assign(this.progress, p);
    this.emit('progress', { ...this.progress });
  }

  cancel() { this.cancelled = true; }

  // opts: { generations: [1,2] | [], includeForms: bool, images: bool, concurrency }
  async run({ generations = [], includeForms = false, images = true, shinyImages = true, concurrency = 6 } = {}) {
    if (this.progress.running) throw new Error('Importazione già in corso');
    this.cancelled = false;
    mkdirSync(this.imagesDir, { recursive: true });
    this.update({ running: true, phase: 'elenco', done: 0, total: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null, message: null });
    try {
      let speciesUrls;
      if (generations.length) {
        speciesUrls = [];
        for (const g of generations) {
          const gen = await this.json(`${this.base}/generation/${g}`);
          for (const s of gen?.pokemon_species || []) speciesUrls.push(s.url);
        }
      } else {
        const list = await this.json(`${this.base}/pokemon-species?limit=100000`);
        speciesUrls = (list?.results || []).map((r) => r.url);
      }
      this.update({ phase: 'specie', total: speciesUrls.length });
      let imported = 0;
      await pool(speciesUrls, concurrency, async (url) => {
        if (this.cancelled) return;
        try {
          const n = await this.importSpecies(url, { includeForms, images, shinyImages });
          imported += n;
        } catch (e) {
          this.progress.errors++;
          this.log.warn('Errore importazione specie', { url, message: e.message });
        }
        this.update({ done: this.progress.done + 1 });
      });
      const msg = this.cancelled ? `Importazione annullata (${imported} Pokémon salvati)` : `Importati ${imported} Pokémon`;
      this.log.info(msg, { errors: this.progress.errors });
      this.update({ running: false, phase: this.cancelled ? 'annullata' : 'completata', finishedAt: new Date().toISOString(), message: msg });
      return { imported, errors: this.progress.errors };
    } catch (e) {
      this.log.error('Importazione PokéAPI fallita', { message: e.message });
      this.update({ running: false, phase: 'errore', finishedAt: new Date().toISOString(), message: e.message });
      throw e;
    }
  }

  async importSpecies(url, { includeForms, images, shinyImages }) {
    const sp = await this.json(url);
    if (!sp) return 0;
    const nameIt = sp.names?.find((n) => n.language?.name === 'it')?.name || null;
    const nameEn = sp.names?.find((n) => n.language?.name === 'en')?.name || sp.name;
    const generation = genNumber(sp.generation?.url) ?? genFromName(sp.generation?.name);
    const rarity = rarityFromSpecies(sp);
    const varieties = (sp.varieties || []).filter((v) => v.is_default || includeForms);
    let count = 0;
    for (const variety of varieties) {
      const pk = await this.json(variety.pokemon.url);
      if (!pk) continue;
      const types = (pk.types || []).sort((a, b) => a.slot - b.slot).map((t) => t.type.name);
      const art = pk.sprites?.other?.['official-artwork'] || {};
      const imgUrl = art.front_default || pk.sprites?.front_default || null;
      const shinyUrl = art.front_shiny || pk.sprites?.front_shiny || null;
      const slug = pk.name;
      let imageFile = null, shinyFile = null;
      if (images) {
        imageFile = await this.download(imgUrl, `${slug}.png`);
        if (shinyImages) shinyFile = await this.download(shinyUrl, `${slug}-shiny.png`);
      }
      const formName = variety.is_default ? null : slug.replace(`${sp.name}-`, '');
      this.db.run(
        `INSERT INTO pokemon (dex_number, slug, name, name_it, form_name, is_default_form, types, generation, capture_rate,
            is_legendary, is_mythical, rarity, enabled, image_url, shiny_image_url, image_file, shiny_image_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           dex_number = excluded.dex_number, name = excluded.name, name_it = excluded.name_it, form_name = excluded.form_name,
           types = excluded.types, generation = excluded.generation, capture_rate = excluded.capture_rate,
           is_legendary = excluded.is_legendary, is_mythical = excluded.is_mythical,
           image_url = excluded.image_url, shiny_image_url = excluded.shiny_image_url,
           image_file = COALESCE(excluded.image_file, pokemon.image_file),
           shiny_image_file = COALESCE(excluded.shiny_image_file, pokemon.shiny_image_file)`,
        sp.id, slug, formName ? `${nameEn} (${formName})` : nameEn, nameIt ? (formName ? `${nameIt} (${formName})` : nameIt) : null,
        formName, variety.is_default ? 1 : 0, JSON.stringify(types), generation, sp.capture_rate ?? null,
        sp.is_legendary ? 1 : 0, sp.is_mythical ? 1 : 0, rarity, variety.is_default ? 1 : 0,
        imgUrl, shinyUrl, imageFile, shinyFile,
      );
      // Nota: rarità, difficoltà, peso e abilitazione impostati dall'admin non vengono sovrascritti.
      count++;
    }
    return count;
  }

  // Scarica le immagini mancanti per i Pokémon già importati.
  async cacheMissingImages({ concurrency = 6 } = {}) {
    mkdirSync(this.imagesDir, { recursive: true });
    const rows = this.db.all('SELECT id, slug, image_url, shiny_image_url, image_file, shiny_image_file FROM pokemon WHERE (image_file IS NULL AND image_url IS NOT NULL) OR (shiny_image_file IS NULL AND shiny_image_url IS NOT NULL)');
    let n = 0;
    await pool(rows, concurrency, async (r) => {
      const f = r.image_file || await this.download(r.image_url, `${r.slug}.png`);
      const s = r.shiny_image_file || await this.download(r.shiny_image_url, `${r.slug}-shiny.png`);
      this.db.run('UPDATE pokemon SET image_file = ?, shiny_image_file = ? WHERE id = ?', f, s, r.id);
      n++;
    });
    return n;
  }

  imageStats() {
    if (!existsSync(this.imagesDir)) return { files: 0, bytes: 0 };
    let files = 0, bytes = 0;
    for (const f of readdirSync(this.imagesDir)) {
      try { bytes += statSync(join(this.imagesDir, f)).size; files++; } catch { /* ignora */ }
    }
    return { files, bytes };
  }
}
