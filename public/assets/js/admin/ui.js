// Componenti UI riutilizzabili della dashboard.
import { h, mount, clear } from '../lib.js';

export function toast(msg, kind = '') {
  const wrap = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` }, msg);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

export function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...children);
}

export function table(cols, rows, { onRow, empty = 'Nessun dato' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      cols.map((c) => h('td', {}, c.render ? c.render(r) : r[c.key] ?? '—')))))));
}

// Esegue un'azione asincrona mostrando l'esito.
export async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  }
}

export function confirmDialog(message, { danger = false, okLabel = 'Conferma' } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(false); } },
      h('div', { class: 'card modal', style: { maxWidth: '460px' } },
        h('p', {}, message),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Annulla'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel))));
    document.body.appendChild(bg);
  });
}

export function promptDialog(message, { placeholder = '', okLabel = 'Conferma', danger = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { placeholder, maxlength: 200 });
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(null); } },
      h('div', { class: 'card modal', style: { maxWidth: '460px' } },
        h('p', {}, message), input,
        h('div', { class: 'row end', style: { marginTop: '12px' } },
          h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Annulla'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(input.value.trim()) }, okLabel))));
    document.body.appendChild(bg);
    input.focus();
  });
}

export function modal(title, body, { onClose } = {}) {
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } });
  const close = () => { bg.remove(); onClose?.(); };
  mount(bg, h('div', { class: 'card modal' }, h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, title), h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm ghost', onclick: close }, '✕')), h('div', { style: { marginTop: '12px' } }, body)));
  document.body.appendChild(bg);
  return { close };
}

// Campo numerico/testo collegato a un oggetto.
export function field(label, obj, key, { type = 'number', step = 'any', min, max, help, options } = {}) {
  let input;
  if (type === 'checkbox') {
    input = h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; } });
    return h('label', { class: 'check' }, input, label, help ? h('span', { class: 'muted small' }, ` — ${help}`) : null);
  }
  if (type === 'select') {
    input = h('select', { onchange: (e) => { obj[key] = e.target.value; } },
      options.map(([v, l]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, l)));
  } else {
    input = h('input', {
      type, step, min, max, value: obj[key] ?? '',
      oninput: (e) => { obj[key] = type === 'number' ? Number(e.target.value) : e.target.value; },
    });
  }
  return h('label', { class: 'field' }, label, input, help ? h('span', { class: 'small' }, help) : null);
}

export function pager(total, limit, offset, onChange) {
  if (total <= limit) return null;
  const pagesN = Math.ceil(total / limit);
  const cur = Math.floor(offset / limit) + 1;
  return h('div', { class: 'row', style: { marginTop: '10px' } },
    h('button', { class: 'btn sm', disabled: cur <= 1, onclick: () => onChange(offset - limit) }, '‹'),
    h('span', { class: 'muted small' }, `Pagina ${cur} di ${pagesN} (${total})`),
    h('button', { class: 'btn sm', disabled: cur >= pagesN, onclick: () => onChange(offset + limit) }, '›'));
}

export function loading(el) { mount(el, h('div', { class: 'muted' }, 'Caricamento…')); }
export { clear };
