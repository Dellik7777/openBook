// Kleine UI-Helfer ohne Framework.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Inline-SVG-Icons (Linien-Stil)
const P = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  images: '<rect x="3" y="5" width="14" height="14" rx="1"/><path d="M7 3h13a1 1 0 0 1 1 1v13"/><path d="M3 16l4-4 3 3 2-2 5 5"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  font: '<path d="M4 19l5-14 5 14M6 14h6"/><path d="M15 19l3-8 3 8M16 16.5h4"/>',
  bookmark: '<path d="M6 3h12v18l-6-5-6 5z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  image: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  text: '<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
  split: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M12 5v14"/>',
  flash: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  figure: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 8"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  zoom: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon ' + cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, label, onClick, cls = '') {
  return h('button', { class: 'icon-btn ' + cls, type: 'button', 'aria-label': label, title: label, onClick }, icon(name));
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Einfaches Sheet/Dialog von unten
export function sheet(title, content, { onClose } = {}) {
  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      iconButton('close', 'Schließen', () => close()),
    ),
    h('div', { class: 'sheet-body' }, content),
  );
  const backdrop = h('div', { class: 'backdrop', onClick: (e) => { if (e.target === backdrop) close(); } }, panel);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  return { close, panel };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet(title, h('div', {},
      h('p', { class: 'muted' }, text),
      h('div', { class: 'row end gap' },
        h('button', { class: 'btn', onClick: () => { done = true; s.close(); resolve(false); } }, 'Abbrechen'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => { done = true; s.close(); resolve(true); } }, okLabel),
      ),
    ), { onClose: () => { if (!done) resolve(false); } });
  });
}

export function pickFiles({ accept = 'image/*', multiple = true, capture = null } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, capture, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// Blob-URLs mit automatischem Aufräumen pro Ansicht
export class UrlPool {
  constructor() { this.urls = []; }
  get(blob) {
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    this.urls.push(u);
    return u;
  }
  clear() { this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls = []; }
}

export function coverColor(title = '') {
  let x = 0;
  for (const c of title) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const palettes = [
    ['#264653', '#e9c46a'], ['#5f0f40', '#fb8b24'], ['#1d3557', '#a8dadc'],
    ['#283618', '#dda15e'], ['#3d405b', '#f2cc8f'], ['#6d2e46', '#d5b9b2'],
    ['#14213d', '#fca311'], ['#2b2d42', '#edf2f4'], ['#004b23', '#ccff33'],
    ['#432818', '#ffe6a7'],
  ];
  return palettes[x % palettes.length];
}

export function download(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function safeName(s) {
  return (s || 'buch').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'buch';
}
