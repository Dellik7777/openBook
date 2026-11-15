// Leseansicht im Kindle-Stil: umbrechender Text in Seiten, Antippen zum Blättern,
// Schrift/Thema einstellbar, Lesezeichen, Suche, Originalseiten-Ansicht.

import * as db from './db.js';
import * as profiles from './profiles.js';
import { h, icon, iconButton, toast, sheet, UrlPool } from './ui.js';
import { buildFlow } from './textproc.js';

const SECTION_PAGES = 25; // Buchseiten je gerendertem Abschnitt (hält das Layout schnell)
const CHARS_PER_MIN = 1300; // ca. 230 Wörter/Minute

const DEFAULTS = {
  fontSize: 19, font: 'literata', lineHeight: 1.55, margin: 'm', align: 'justify', theme: 'paper', mode: 'text', footer: 'page',
};
const FONTS = {
  literata: { label: 'Literata', css: '"Literata", Georgia, "Times New Roman", serif' },
  georgia: { label: 'Georgia', css: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
  sans: { label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  dyslexic: { label: 'Weit', css: 'Verdana, "Atkinson Hyperlegible", Tahoma, sans-serif' },
};
const THEMES = { white: 'Weiß', paper: 'Papier', sepia: 'Sepia', dark: 'Dunkel', black: 'Schwarz' };
const MARGINS = { s: 16, m: 28, l: 48 };

// Leseeinstellungen gehören zum aktiven Profil (und werden mit ihm synchronisiert)
function loadSettings() { return { ...DEFAULTS, ...profiles.getSettings() }; }
function saveSettings(s) { profiles.saveSettings(s); }

export async function openReader(root, bookId) {
  let book = await db.getBook(bookId);
  if (!book) { location.hash = '#/'; return; }
  let pages = await db.getPagesMeta(bookId);
  if (!pages.length) { location.hash = `#/book/${bookId}`; return; }
  const profileId = profiles.currentId();
  let state = (await db.getState(profileId, bookId)) || { position: null, bookmarks: [] };
  let lastSavedAt = state.updatedAt || 0;
  // Nur echtes Blättern zählt als neue Leseposition – bloßes Öffnen (oder ein anderes
  // Layout auf diesem Gerät) darf die Position eines anderen Geräts nicht überschreiben.
  let userMoved = false;
  const userNav = () => { userMoved = true; };
  db.updateState(profileId, bookId, { lastOpenedAt: Date.now() }, { touch: false });

  const settings = loadSettings();
  const pool = new UrlPool();
  let flow = [], cum = [], totalChars = 1, sections = [];
  let sectionIdx = -1, screen = 0, screens = 1, colW = 0, gap = 0;
  let imgIndex = 0;
  let menuOpen = false;
  let pos = state.position || null; // { pageId, p, char, ratio, pageIndex }

  // ---------- DOM ----------
  const content = h('div', { class: 'r-content', lang: 'de' });
  const frame = h('div', { class: 'r-frame' }, content);
  const imgView = h('div', { class: 'r-images', hidden: true });
  const ribbon = h('div', { class: 'r-ribbon', hidden: true });
  const footLeft = h('button', { class: 'r-foot-btn', onClick: (e) => { e.stopPropagation(); cycleFooter(); } });
  const footRight = h('span', { class: 'r-foot-pct' });
  const footer = h('div', { class: 'r-footer' }, footLeft, footRight);
  const header = h('div', { class: 'r-header' }, h('span', {}, book.title));

  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'r-slider', 'aria-label': 'Position im Buch' });
  const sliderLabel = h('div', { class: 'r-slider-label' });
  const bmBtn = iconButton('bookmark', 'Lesezeichen setzen', () => toggleBookmark());
  const modeBtn = iconButton(settings.mode === 'text' ? 'image' : 'text', 'Ansicht wechseln', () => switchMode());
  const zoomBtn = iconButton('zoom', 'Zoom', () => toggleZoom());
  zoomBtn.hidden = settings.mode !== 'images';

  const menuTop = h('div', { class: 'r-menu-top' },
    iconButton('back', 'Zur Bibliothek', () => { location.hash = '#/'; }),
    h('div', { class: 'r-menu-title' }, h('div', {}, book.title), book.author ? h('div', { class: 'muted small' }, book.author) : null),
    zoomBtn,
    modeBtn,
    iconButton('font', 'Schrift & Darstellung', () => openTypography()),
    iconButton('search', 'Im Buch suchen', () => openSearch()),
    iconButton('list', 'Lesezeichen & Seiten', () => openContents()),
    bmBtn,
  );
  const menuBottom = h('div', { class: 'r-menu-bottom' },
    sliderLabel,
    h('div', { class: 'row gap-s' },
      iconButton('left', 'Zurück', () => prev(), 'small'),
      slider,
      iconButton('right', 'Weiter', () => next(), 'small'),
    ),
    h('div', { class: 'row between small muted' },
      h('a', { href: `#/book/${bookId}`, class: 'linkish' }, 'Buchdetails & Seiten bearbeiten'),
    ),
  );

  const viewport = h('div', { class: 'r-viewport' }, frame, imgView, ribbon);
  const view = h('div', { class: 'reader' }, header, viewport, footer, menuTop, menuBottom);
  root.append(view);
  applySettings();

  // ---------- Fluss & Abschnitte ----------
  function rebuildFlow() {
    flow = buildFlow(pages);
    cum = new Array(flow.length + 1);
    cum[0] = 0;
    for (let i = 0; i < flow.length; i++) cum[i + 1] = cum[i] + flow[i].text.length + 1;
    totalChars = Math.max(1, cum[flow.length]);
    sections = [];
    let start = 0;
    for (let i = 1; i <= flow.length; i++) {
      const brk = i === flow.length || Math.floor(flow[i].pageIndex / SECTION_PAGES) !== Math.floor(flow[start].pageIndex / SECTION_PAGES);
      if (brk) { sections.push([start, i]); start = i; }
    }
    sectionIdx = -1;
  }

  function flowIndexFor(p) {
    if (!p) return 0;
    let i = flow.findIndex((f) => f.pageId === p.pageId && f.p === p.p);
    if (i >= 0) return i;
    i = flow.findIndex((f) => f.continues && f.continues.some((c) => c.pageId === p.pageId));
    if (i >= 0) return i;
    i = flow.findIndex((f) => f.pageId === p.pageId);
    if (i >= 0) return i;
    if (p.ratio != null) return flowIndexAtGlobal(p.ratio * totalChars);
    return 0;
  }
  function flowIndexAtGlobal(g) {
    let lo = 0, hi = flow.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= g) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function sectionOf(fi) { return Math.max(0, sections.findIndex(([a, b]) => fi >= a && fi < b)); }

  function sourcePageAt(fi, char) {
    const f = flow[fi];
    if (!f) return 0;
    let pi = f.pageIndex;
    for (const c of f.continues || []) if (char >= c.offset) pi = c.pageIndex;
    return pi;
  }

  // ---------- Rendering Text ----------
  function renderSection(si) {
    sectionIdx = si;
    const [a, b] = sections[si];
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      const f = flow[i];
      const prevF = flow[i - 1];
      const el = h('p', { 'data-fi': i, class: f.placeholder ? 'ph' : (prevF && prevF.placeholder) || i === a ? 'first' : '' });
      if (f.placeholder) {
        el.append(f.text + ' ');
        el.append(h('button', { class: 'linkish', 'data-show-page': f.pageIndex }, 'Original ansehen'));
      } else {
        el.textContent = f.text;
      }
      frag.append(el);
    }
    content.replaceChildren(frag);
    measure();
  }

  function measure() {
    const m = MARGINS[settings.margin] || 28;
    const W = viewport.clientWidth;
    const H = viewport.clientHeight;
    // Zeilen nicht zu lang werden lassen (Tablet/Desktop): max. ca. 34em
    colW = Math.max(200, Math.min(W - 2 * m, Math.round(settings.fontSize * 34)));
    gap = 2 * m;
    frame.style.left = Math.round((W - colW) / 2) + 'px';
    frame.style.width = colW + 'px';
    const fs = settings.fontSize;
    const lh = Math.round(fs * settings.lineHeight);
    // Höhe auf ganze Zeilen runden, damit keine halben Zeilen abgeschnitten werden
    const vpad = Math.max(12, Math.round(m * 0.5));
    let hgt = H - 2 * vpad;
    hgt = Math.max(lh * 3, Math.floor(hgt / lh) * lh);
    frame.style.top = Math.round((H - hgt) / 2) + 'px';
    frame.style.height = hgt + 'px';
    content.style.height = hgt + 'px';
    content.style.columnWidth = colW + 'px';
    content.style.columnGap = gap + 'px';
    const last = content.lastElementChild;
    if (!last) { screens = 1; return; }
    const base = content.getBoundingClientRect().left;
    const rects = last.getClientRects();
    const r = rects[rects.length - 1] || last.getBoundingClientRect();
    screens = Math.max(1, Math.ceil((r.right - base - 1) / (colW + gap)));
  }

  let locateTimer = null;
  function showScreen(n, animate = false) {
    screen = Math.max(0, Math.min(screens - 1, n));
    content.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    content.style.transform = `translateX(${-screen * (colW + gap)}px)`;
    // Während der Animation stimmen Bildschirmkoordinaten nicht → danach messen
    clearTimeout(locateTimer);
    if (animate) locateTimer = setTimeout(updatePositionFromScreen, 200);
    else updatePositionFromScreen();
  }

  // Erste sichtbare Textstelle auf dem aktuellen Bildschirm ermitteln
  function locate(screenNo) {
    const base = content.getBoundingClientRect().left;
    const x0 = screenNo * (colW + gap);
    const x1 = x0 + colW;
    const els = content.children;
    for (const el of els) {
      const rects = el.getClientRects();
      for (const r of rects) {
        const left = r.left - base;
        if (left >= x0 - 1 && left < x1) {
          const fi = +el.dataset.fi;
          let char = 0;
          // Absatz beginnt auf früherem Bildschirm → Zeichenposition am Spaltenanfang ermitteln
          if (rects[0].left - base < x0 - 1) char = charAtColumn(el, x0);
          return { fi, char };
        }
      }
    }
    const lastEl = els[els.length - 1];
    return lastEl ? { fi: +lastEl.dataset.fi, char: 0 } : { fi: 0, char: 0 };
  }

  // Erstes Zeichen des Absatzes, das in der Spalte ab x0 steht (binäre Suche über Zeichen-Rechtecke).
  // Unabhängig von Menüs/Overlays, die über dem Text liegen könnten.
  function charAtColumn(el, x0) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3 || !node.length) return 0;
    const base = content.getBoundingClientRect().left;
    const r = document.createRange();
    const leftOf = (i) => {
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rc = r.getClientRects()[0] || r.getBoundingClientRect();
      return rc.left - base;
    };
    let lo = 0, hi = node.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (leftOf(mid) >= x0 - 1) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    // Leerzeichen am Spaltenanfang überspringen
    while (ans < node.length - 1 && /\s/.test(node.data[ans])) ans++;
    return ans;
  }

  function screenOfChar(fi, char) {
    const el = content.querySelector(`[data-fi="${fi}"]`);
    if (!el) return 0;
    const base = content.getBoundingClientRect().left;
    let rect = null;
    if (char > 0 && el.firstChild && el.firstChild.nodeType === 3) {
      const r = document.createRange();
      const off = Math.min(char, el.firstChild.length - 1);
      r.setStart(el.firstChild, Math.max(0, off));
      r.setEnd(el.firstChild, Math.max(0, off) + 1);
      rect = r.getClientRects()[0] || null;
    }
    if (!rect) rect = el.getClientRects()[0];
    if (!rect) return 0;
    return Math.max(0, Math.floor((rect.left - base + 1) / (colW + gap)));
  }

  function goToFlow(fi, char = 0) {
    if (!flow.length) return;
    fi = Math.max(0, Math.min(flow.length - 1, fi));
    const si = sectionOf(fi);
    if (si !== sectionIdx) renderSection(si);
    showScreen(screenOfChar(fi, char));
  }

  function updatePositionFromScreen() {
    const { fi, char } = locate(screen);
    const f = flow[fi];
    if (!f) return;
    const ratio = screen >= screens - 1 && sectionIdx === sections.length - 1 ? 1 : (cum[fi] + char) / totalChars;
    pos = { pageId: f.pageId, p: f.p, char, ratio, pageIndex: sourcePageAt(fi, char) };
    afterMove();
  }

  // ---------- Rendering Bilder ----------
  let zoomed = false;
  function renderImage(i) {
    imgIndex = Math.max(0, Math.min(pages.length - 1, i));
    pool.clear();
    const p = pages[imgIndex];
    imgView.replaceChildren(p.image
      ? h('img', { src: pool.get(p.image), alt: `Seite ${imgIndex + 1}`, draggable: 'false' })
      : h('div', { class: 'r-noimage' }, h('p', {}, `Seite ${imgIndex + 1}`), h('p', { class: 'muted small' }, 'Das Originalfoto liegt nur auf dem Gerät, mit dem die Seite gescannt wurde. Synchronisiert wird nur der Text.')));
    imgView.classList.toggle('zoomed', zoomed);
    imgView.scrollTo(0, 0);
    // Position so speichern, dass die Textansicht dieselbe Buchseite findet
    const fi = flow.findIndex((f) => f.pageIndex === imgIndex);
    pos = { pageId: p.id, p: fi >= 0 ? flow[fi].p : 0, char: 0, ratio: pages.length > 1 ? imgIndex / (pages.length - 1) : 1, pageIndex: imgIndex };
    afterMove();
  }

  function toggleZoom() {
    zoomed = !zoomed;
    imgView.classList.toggle('zoomed', zoomed);
    toast(zoomed ? 'Zoom an – zum Blättern Zoom wieder ausschalten' : 'Zoom aus');
  }

  // ---------- Navigation ----------
  function next() {
    userNav();
    if (settings.mode === 'images') {
      if (imgIndex < pages.length - 1) renderImage(imgIndex + 1); else endOfBook();
      return;
    }
    if (screen < screens - 1) showScreen(screen + 1, true);
    else if (sectionIdx < sections.length - 1) { renderSection(sectionIdx + 1); showScreen(0); }
    else endOfBook();
  }
  function prev() {
    userNav();
    if (settings.mode === 'images') { if (imgIndex > 0) renderImage(imgIndex - 1); return; }
    if (screen > 0) showScreen(screen - 1, true);
    else if (sectionIdx > 0) { renderSection(sectionIdx - 1); showScreen(screens - 1); }
  }
  function endOfBook() { toast('Ende des Buchs'); }

  let saveTimer = null;
  function afterMove() {
    updateFooter();
    updateBookmarkState();
    if (!sliderDragging) slider.value = Math.round((pos?.ratio || 0) * 1000);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (pos && userMoved) { lastSavedAt = Date.now(); db.updateState(profileId, bookId, { position: pos, lastOpenedAt: Date.now() }); }
    }, 400);
  }

  function restore() {
    if (settings.mode === 'images') {
      const pi = pos ? (pos.pageIndex ?? pages.findIndex((p) => p.id === pos.pageId)) : 0;
      renderImage(pi >= 0 ? pi : 0);
    } else {
      const fi = flowIndexFor(pos);
      goToFlow(fi, pos && flow[fi] && flow[fi].pageId === pos.pageId && flow[fi].p === pos.p ? pos.char || 0 : 0);
    }
  }

  // ---------- Fußzeile ----------
  function updateFooter() {
    if (!pos) return;
    const pct = Math.round((pos.ratio || 0) * 100);
    footRight.textContent = `${pct} %`;
    const pi = (pos.pageIndex ?? 0) + 1;
    const left = (1 - (pos.ratio || 0)) * totalChars / CHARS_PER_MIN;
    const leftTxt = left < 1 ? 'weniger als 1 Min.' : left < 60 ? `${Math.round(left)} Min.` : `${Math.floor(left / 60)} Std. ${Math.round(left % 60)} Min.`;
    footLeft.textContent = settings.footer === 'time'
      ? `Noch ${leftTxt} im Buch`
      : settings.footer === 'none' ? '' : `Seite ${pi} von ${pages.length}`;
    sliderLabel.textContent = `Seite ${pi} von ${pages.length} · ${pct} %`;
  }
  function cycleFooter() {
    settings.footer = { page: 'time', time: 'none', none: 'page' }[settings.footer] || 'page';
    saveSettings(settings);
    updateFooter();
  }

  // ---------- Lesezeichen ----------
  function globalOf(b) {
    const fi = flowIndexFor(b);
    return cum[fi] + (flow[fi] && flow[fi].pageId === b.pageId && flow[fi].p === b.p ? (b.char || 0) : 0);
  }
  function currentRange() {
    if (settings.mode === 'images') return null;
    const s = locate(screen);
    const start = cum[s.fi] + s.char;
    let end = Infinity;
    if (screen < screens - 1) { const e = locate(screen + 1); end = cum[e.fi] + e.char; }
    else if (sectionIdx < sections.length - 1) end = cum[sections[sectionIdx + 1][0]];
    return [start, end];
  }
  function bookmarkHere() {
    const bms = state.bookmarks || [];
    if (settings.mode === 'images') return bms.find((b) => b.pageIndex === imgIndex && b.image);
    const r = currentRange();
    return bms.find((b) => !b.image && (() => { const g = globalOf(b); return g >= r[0] && g < r[1]; })());
  }
  function updateBookmarkState() {
    const on = !!bookmarkHere();
    ribbon.hidden = !on;
    bmBtn.classList.toggle('active', on);
  }
  async function toggleBookmark() {
    const existing = bookmarkHere();
    let bms = [...(state.bookmarks || [])];
    if (existing) {
      bms = bms.filter((b) => b !== existing);
      toast('Lesezeichen entfernt');
    } else {
      const fi = settings.mode === 'images' ? flowIndexFor(pos) : locate(screen).fi;
      const f = flow[fi];
      const snippet = settings.mode === 'images' ? `Seite ${imgIndex + 1} (Original)` : f.text.slice(pos.char || 0, (pos.char || 0) + 90).trim() + '…';
      bms.push({ ...pos, label: snippet, createdAt: Date.now(), image: settings.mode === 'images', pageIndex: pos.pageIndex });
      toast('Lesezeichen gesetzt');
    }
    state = await db.updateState(profileId, bookId, { bookmarks: bms });
    updateBookmarkState();
  }

  // ---------- Inhalt (Lesezeichen & Seiten) ----------
  function openContents() {
    const list = h('div', { class: 'stack' });
    const tabs = h('div', { class: 'segmented' });
    const thumbPool = new UrlPool();
    const show = (which) => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === which));
      thumbPool.clear();
      if (which === 'bm') {
        const bms = [...(state.bookmarks || [])].sort((a, b) => globalOf(a) - globalOf(b));
        list.replaceChildren(...(bms.length ? bms.map((b) => h('button', { class: 'menu-item multi', onClick: () => { s.close(); jumpTo(b); } },
          icon('bookmark'),
          h('span', {}, h('span', { class: 'small muted' }, `Seite ${(b.pageIndex ?? 0) + 1} · ${Math.round((b.ratio || 0) * 100)} %`), h('br'), b.label),
        )) : [h('p', { class: 'muted' }, 'Noch keine Lesezeichen. Tippe oben auf das Lesezeichen-Symbol, um eins zu setzen.')]));
      } else {
        list.replaceChildren(h('div', { class: 'pages-grid compact' }, ...pages.map((p, i) => h('button', {
          class: 'page-tile' + (i === (pos?.pageIndex ?? -1) ? ' current' : ''),
          onClick: () => { s.close(); jumpToPage(i); },
        }, h('img', { src: thumbPool.get(p.thumb), alt: '', loading: 'lazy' }), h('span', { class: 'page-no' }, i + 1)))));
      }
    };
    tabs.append(
      h('button', { 'data-t': 'bm', onClick: () => show('bm') }, 'Lesezeichen'),
      h('button', { 'data-t': 'pages', onClick: () => show('pages') }, 'Seiten'),
    );
    const s = sheet('Inhalt', h('div', { class: 'stack' }, tabs, list), { onClose: () => thumbPool.clear() });
    show((state.bookmarks || []).length ? 'bm' : 'pages');
  }

  function jumpTo(b) {
    userNav();
    closeMenu();
    if (settings.mode === 'images') { renderImage(b.pageIndex ?? 0); return; }
    const fi = flowIndexFor(b);
    goToFlow(fi, flow[fi] && flow[fi].pageId === b.pageId && flow[fi].p === b.p ? b.char || 0 : 0);
  }
  function jumpToPage(i) {
    userNav();
    closeMenu();
    if (settings.mode === 'images') { renderImage(i); return; }
    let fi = flow.findIndex((f) => f.pageIndex === i);
    let char = 0;
    if (fi < 0) {
      fi = flow.findIndex((f) => f.continues && f.continues.some((c) => c.pageIndex === i));
      if (fi >= 0) char = flow[fi].continues.find((c) => c.pageIndex === i).offset;
    }
    if (fi < 0) fi = flowIndexAtGlobal(totalChars * (i / pages.length));
    goToFlow(fi, char);
  }

  // ---------- Suche ----------
  function openSearch() {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Wort oder Satz suchen …', enterkeyhint: 'search' });
    const results = h('div', { class: 'stack' });
    let t = null;
    const run = () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { results.replaceChildren(); return; }
      const out = [];
      for (let i = 0; i < flow.length && out.length < 200; i++) {
        const f = flow[i];
        if (f.placeholder) continue;
        const low = f.text.toLowerCase();
        let at = low.indexOf(q);
        while (at >= 0 && out.length < 200) {
          out.push({ fi: i, char: at });
          at = low.indexOf(q, at + q.length);
        }
      }
      results.replaceChildren(
        h('p', { class: 'muted small' }, out.length ? `${out.length}${out.length === 200 ? '+' : ''} Treffer` : 'Keine Treffer'),
        ...out.map(({ fi, char }) => {
          const txt = flow[fi].text;
          const a = Math.max(0, char - 50), b = Math.min(txt.length, char + q.length + 60);
          return h('button', { class: 'menu-item multi', onClick: () => { s.close(); closeMenu(); userNav(); goToFlow(fi, char); } },
            h('span', {},
              h('span', { class: 'small muted' }, `Seite ${sourcePageAt(fi, char) + 1}`), h('br'),
              (a > 0 ? '…' : '') + txt.slice(a, char), h('mark', {}, txt.slice(char, char + q.length)), txt.slice(char + q.length, b) + (b < txt.length ? '…' : ''),
            ));
        }),
      );
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
    if (settings.mode === 'images') {
      results.append(h('p', { class: 'muted small' }, 'Die Suche durchsucht den erkannten Text. Ein Treffer öffnet die Textansicht.'));
    }
    const s = sheet('Suchen', h('div', { class: 'stack' }, input, results));
    setTimeout(() => input.focus(), 250);
  }

  // ---------- Darstellung ----------
  function applySettings() {
    view.dataset.theme = settings.theme;
    content.style.fontFamily = (FONTS[settings.font] || FONTS.literata).css;
    content.style.fontSize = settings.fontSize + 'px';
    content.style.lineHeight = String(settings.lineHeight);
    content.style.textAlign = settings.align;
    content.style.hyphens = settings.align === 'justify' ? 'auto' : 'manual';
    frame.hidden = settings.mode !== 'text';
    imgView.hidden = settings.mode !== 'images';
    zoomBtn.hidden = settings.mode !== 'images';
    modeBtn.replaceChildren(icon(settings.mode === 'text' ? 'image' : 'text'));
    const modeLabel = settings.mode === 'text' ? 'Originalfotos anzeigen' : 'Textansicht';
    modeBtn.title = modeLabel;
    modeBtn.setAttribute('aria-label', modeLabel);
  }

  function relayout() {
    const keep = pos;
    applySettings();
    if (settings.mode === 'text') {
      sectionIdx = -1;
      pos = keep;
      restore();
    }
  }

  function openTypography() {
    const sizeOut = h('span', { class: 'muted small' });
    const setSize = (v) => {
      settings.fontSize = Math.max(13, Math.min(34, v));
      sizeOut.textContent = settings.fontSize + ' px';
      saveSettings(settings); relayout();
    };
    sizeOut.textContent = settings.fontSize + ' px';
    const seg = (key, options, after) => {
      const wrap = h('div', { class: 'segmented' });
      for (const [val, label] of Object.entries(options)) {
        wrap.append(h('button', {
          class: String(settings[key]) === String(val) ? 'on' : '',
          'data-v': val,
          onClick: () => {
            settings[key] = typeof DEFAULTS[key] === 'number' ? Number(val) : val;
            wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
            saveSettings(settings); relayout(); after && after();
          },
        }, label));
      }
      return wrap;
    };
    const fontSeg = h('div', { class: 'segmented' });
    for (const [k, f] of Object.entries(FONTS)) {
      fontSeg.append(h('button', { class: settings.font === k ? 'on' : '', 'data-v': k, style: { fontFamily: f.css }, onClick: () => {
        settings.font = k;
        fontSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === k));
        saveSettings(settings); relayout();
      } }, f.label));
    }
    const themeRow = h('div', { class: 'themes' });
    for (const [k, label] of Object.entries(THEMES)) {
      themeRow.append(h('button', { class: 'theme-swatch t-' + k + (settings.theme === k ? ' on' : ''), 'data-v': k, onClick: () => {
        settings.theme = k;
        themeRow.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === k));
        saveSettings(settings); applySettings();
      } }, 'Aa', h('small', {}, label)));
    }
    sheet('Darstellung', h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('strong', {}, 'Schriftgröße'), sizeOut),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'btn', style: { fontSize: '14px' }, onClick: () => setSize(settings.fontSize - 1) }, 'A−'),
        h('input', { type: 'range', min: 13, max: 34, value: settings.fontSize, class: 'grow', 'aria-label': 'Schriftgröße', onChange: (e) => setSize(+e.target.value) }),
        h('button', { class: 'btn', style: { fontSize: '20px' }, onClick: () => setSize(settings.fontSize + 1) }, 'A+'),
      ),
      h('strong', {}, 'Schrift'), fontSeg,
      h('strong', {}, 'Hintergrund'), themeRow,
      h('strong', {}, 'Zeilenabstand'), seg('lineHeight', { 1.35: 'Eng', 1.55: 'Normal', 1.8: 'Weit' }),
      h('strong', {}, 'Ränder'), seg('margin', { s: 'Schmal', m: 'Normal', l: 'Breit' }),
      h('strong', {}, 'Ausrichtung'), seg('align', { justify: 'Blocksatz', left: 'Linksbündig' }),
    ));
  }

  function switchMode() {
    const pi = pos?.pageIndex ?? 0;
    settings.mode = settings.mode === 'text' ? 'images' : 'text';
    saveSettings(settings);
    applySettings();
    zoomed = false;
    if (settings.mode === 'images') renderImage(pi);
    else { sectionIdx = -1; jumpToPage(pi); }
    toast(settings.mode === 'images' ? 'Originalfotos' : 'Textansicht');
  }

  // ---------- Menü ----------
  function openMenu() { menuOpen = true; view.classList.add('menu-open'); }
  function closeMenu() { menuOpen = false; view.classList.remove('menu-open'); }

  let sliderDragging = false;
  slider.addEventListener('input', () => {
    sliderDragging = true;
    const r = slider.value / 1000;
    if (settings.mode === 'images') {
      sliderLabel.textContent = `Seite ${Math.round(r * (pages.length - 1)) + 1} von ${pages.length}`;
    } else {
      const fi = flowIndexAtGlobal(r * totalChars);
      sliderLabel.textContent = `Seite ${sourcePageAt(fi, 0) + 1} von ${pages.length} · ${Math.round(r * 100)} %`;
    }
  });
  slider.addEventListener('change', () => {
    userNav();
    const r = slider.value / 1000;
    sliderDragging = false;
    if (settings.mode === 'images') renderImage(Math.round(r * (pages.length - 1)));
    else {
      const g = r * totalChars;
      const fi = flowIndexAtGlobal(g);
      goToFlow(fi, Math.max(0, Math.round(g - cum[fi])));
    }
  });

  // ---------- Gesten ----------
  let start = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  viewport.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
    start = null;
    const showBtn = e.target.closest && e.target.closest('[data-show-page]');
    if (showBtn) { switchModeTo('images', +showBtn.dataset.showPage); return; }
    if (zoomed && settings.mode === 'images') { if (menuOpen) closeMenu(); else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) openMenu(); return; }
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 800) {
      if (menuOpen) closeMenu();
      if (dx < 0) next(); else prev();
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 600) {
      if (menuOpen) { closeMenu(); return; }
      const w = viewport.clientWidth;
      const x = e.clientX - viewport.getBoundingClientRect().left;
      if (x < w * 0.3) prev();
      else if (x > w * 0.7) next();
      else openMenu();
    }
  });
  viewport.addEventListener('pointercancel', () => { start = null; });

  function switchModeTo(mode, pi) {
    userNav();
    if (settings.mode !== mode) {
      settings.mode = mode; saveSettings(settings); applySettings();
    }
    if (mode === 'images') renderImage(pi); else jumpToPage(pi);
  }

  const onKey = (e) => {
    if (document.querySelector('.backdrop')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === 'Escape') { if (menuOpen) closeMenu(); else location.hash = '#/'; }
  };
  document.addEventListener('keydown', onKey);

  // Mausrad am Desktop
  let wheelLock = 0;
  viewport.addEventListener('wheel', (e) => {
    if (zoomed) return;
    if (Date.now() < wheelLock) return;
    if (Math.abs(e.deltaY) + Math.abs(e.deltaX) < 20) return;
    wheelLock = Date.now() + 350;
    if (e.deltaY > 0 || e.deltaX > 0) next(); else prev();
  }, { passive: true });

  let resizeTimer = null;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 150); };
  window.addEventListener('resize', onResize);

  // Neue OCR-Ergebnisse und synchronisierte Änderungen einarbeiten, ohne die Leseposition zu verlieren
  let refreshTimer = null;
  const off = db.onChange((e) => {
    const isSync = e.type === 'sync';
    if (!isSync && (e.bookId !== bookId || e.type === 'book' || e.type === 'state' || e.type === 'profile')) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const keep = pos;
      const newPages = await db.getPagesMeta(bookId);
      book = (await db.getBook(bookId)) || book;
      if (!newPages.length) return;
      const textChanged = newPages.length !== pages.length || newPages.some((p, i) => p.id !== pages[i].id || p.text !== pages[i].text);
      pages = newPages;
      if (textChanged) {
        rebuildFlow();
        pos = keep;
        if (settings.mode === 'images') renderImage(Math.min(imgIndex, pages.length - 1)); else restore();
      }
      if (isSync) checkRemotePosition();
    }, isSync ? 50 : 1200);
  });

  // Wurde auf einem anderen Gerät (gleiches Profil) weitergelesen? → anbieten, dorthin zu springen
  const banner = h('div', { class: 'r-banner', hidden: true });
  view.append(banner);
  async function checkRemotePosition() {
    const s = await db.getState(profileId, bookId);
    if (!s) return;
    state = s;
    updateBookmarkState();
    const rp = s.position;
    if (!rp || (s.updatedAt || 0) <= lastSavedAt || !pos) return;
    if (Math.abs((rp.ratio || 0) - (pos.ratio || 0)) < 0.005) return;
    if (!userMoved) {
      // Noch nicht geblättert → einfach zur neuesten Stelle springen
      lastSavedAt = s.updatedAt;
      pos = rp;
      if (settings.mode === 'images') renderImage(rp.pageIndex ?? 0); else restore();
      toast('Leseposition vom anderen Gerät übernommen');
      return;
    }
    banner.replaceChildren(
      h('span', {}, `Auf einem anderen Gerät bis Seite ${(rp.pageIndex ?? 0) + 1} (${Math.round((rp.ratio || 0) * 100)} %) gelesen.`),
      h('button', { class: 'btn small primary', onClick: (ev) => { ev.stopPropagation(); banner.hidden = true; lastSavedAt = s.updatedAt; pos = rp; if (settings.mode === 'images') renderImage(rp.pageIndex ?? 0); else restore(); } }, 'Dorthin'),
      h('button', { class: 'btn small', onClick: (ev) => { ev.stopPropagation(); banner.hidden = true; lastSavedAt = Date.now(); } }, 'Hierbleiben'),
    );
    banner.hidden = false;
  }

  // Wakelock: Bildschirm beim Lesen nicht abschalten
  let wakeLock = null;
  const lock = async () => { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ } };
  const onVis = () => { if (document.visibilityState === 'visible') lock(); };
  document.addEventListener('visibilitychange', onVis);
  lock();

  // Schrift laden, bevor gemessen wird
  try { await document.fonts.load(`${settings.fontSize}px Literata`); } catch (e) { /* ignorieren */ }
  rebuildFlow();
  restore();
  try {
    if (!localStorage.getItem('ob.hint')) {
      localStorage.setItem('ob.hint', '1');
      setTimeout(() => toast('Tippe rechts zum Weiterblättern, in die Mitte für das Menü', 4000), 400);
    }
  } catch (e) { /* ignorieren */ }

  return () => {
    clearTimeout(saveTimer);
    if (pos && userMoved) db.updateState(profileId, bookId, { position: pos, lastOpenedAt: Date.now() });
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    clearTimeout(refreshTimer);
    off();
    if (wakeLock) wakeLock.release().catch(() => {});
    pool.clear();
  };
}
