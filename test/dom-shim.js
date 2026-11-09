// DOM minimo per eseguire public/assets/js/overlay.js in Node (nessuna
// dipendenza esterna). Copre solo ciò che l'overlay usa: elementi, classi,
// stile, dataset, testo, selettori semplici (tag, .classe, [attributo]) e i
// messaggi postMessage dell'anteprima. Non simula il layout né il CSS.

class Classes {
  constructor(elm) { this.el = elm; }
  get list() { return this.el.className.split(/\s+/).filter(Boolean); }
  set(list) { this.el.className = [...new Set(list)].join(' '); }
  add(...k) { this.set([...this.list, ...k]); }
  remove(...k) { this.set(this.list.filter((c) => !k.includes(c))); }
  contains(k) { return this.list.includes(k); }
  toggle(k, force) {
    const on = force === undefined ? !this.contains(k) : !!force;
    if (on) this.add(k); else this.remove(k);
    return on;
  }
  [Symbol.iterator]() { return this.list[Symbol.iterator](); }
}

class Text {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
  remove() { this.parentNode?.removeChild(this); }
}

export class Elem {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.dataset = {};
    this.attrs = {};
    const props = {};
    this.style = new Proxy(props, {
      get: (o, k) => (k === 'setProperty' ? (n, v) => { o[n] = String(v); } : k === 'getPropertyValue' ? (n) => o[n] ?? '' : o[k]),
      set: (o, k, v) => { o[k] = v; return true; },
    });
    this.classList = new Classes(this);
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument?.root; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v != null) this.appendChild(new Text(v)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs[k] ?? null; }
  addEventListener() {}
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    // <link> del tema: "caricato" al giro successivo del ciclo degli eventi.
    if (n.tagName === 'LINK' && typeof n.onload === 'function') setTimeout(() => n.onload?.(), n.ownerDocument.cssDelayMs);
    return n;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new Text(n) : n); }
  replaceChildren(...nodes) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i.exec(sel.trim());
    if (!m) throw new Error(`selettore non supportato dal DOM di test: ${sel}`);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].split('.').filter(Boolean)) if (!this.classList.contains(c)) return false;
    for (const a of m[3].match(/[\w-]+/g) || []) {
      if (a.startsWith('data-')) { const k = a.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase()); if (!(k in this.dataset)) return false; } else if (!(a in this.attrs)) return false;
    }
    return true;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// Installa document/window/location/fetch globali. `messages` raccoglie ciò che
// l'overlay invia alla pagina madre (anteprima).
export function installDom({ settings, search = '?preview=1', cssDelayMs = 0 } = {}) {
  const doc = {
    cssDelayMs,
    createElement: (t) => new Elem(t, doc),
    createElementNS: (_ns, t) => new Elem(t, doc),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => findId(doc.root, id),
    querySelectorAll: (sel) => doc.root.querySelectorAll(sel),
    querySelector: (sel) => doc.root.querySelector(sel),
    hidden: false,
  };
  const findId = (n, id) => { for (const c of n.children) { if (c.id === id) return c; const f = findId(c, id); if (f) return f; } return null; };
  doc.root = new Elem('html', doc);
  doc.documentElement = doc.root;
  doc.head = new Elem('head', doc);
  doc.body = new Elem('body', doc);
  doc.root.append(doc.head, doc.body);
  for (const [id, cls] of [['stage', ''], ['spawn', 'spawn hidden'], ['notes', 'notes']]) {
    const e = new Elem('div', doc); e.id = id; e.className = cls; doc.body.appendChild(e);
  }
  const listeners = [];
  const messages = [];
  const origin = 'http://overlay.test';
  const win = {
    innerWidth: 1920, innerHeight: 1080,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener() {},
    parent: { postMessage: (m) => messages.push(m) },
  };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.location = { search, origin, protocol: 'http:', host: 'overlay.test' };
  globalThis.fetch = async () => ({ json: async () => ({ settings }) });
  // Messaggio dalla pagina del Designer (stessa origine), come fa l'anteprima.
  const post = (type, data) => { for (const fn of listeners) fn({ origin, data: { source: 'livecatch-preview', type, data } }); };
  return { doc, win, post, messages, spawnEl: () => doc.getElementById('spawn'), notesEl: () => doc.getElementById('notes') };
}

let n = 0;
// Carica una nuova istanza del modulo overlay (stato pulito) e attende che sia pronta.
export async function loadOverlay(env) {
  await import(`../public/assets/js/overlay.js?i=${++n}`);
  for (let i = 0; i < 200 && !env.messages.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 5));
  if (!env.messages.some((m) => m.type === 'ready')) throw new Error('overlay non pronto');
  return () => window.__liveCatchOverlay.state();
}
