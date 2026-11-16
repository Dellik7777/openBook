// Leseansicht im Kindle-Stil: umbrechender Text in Seiten, Antippen zum Blättern,
// Schrift/Thema einstellbar, Lesezeichen, Suche, Originalseiten-Ansicht.

import * as db from './db.js';
import * as profiles from './profiles.js';
import { h, icon, iconButton, toast, sheet, UrlPool, download, safeName } from './ui.js';
import { buildFlow } from './textproc.js';
import { displayNumbers } from './pagecheck.js';
import { renderInline, parseBlock, renderTable } from './rich.js';
import { ensureBookAccess } from './lock.js';
import { takeJump } from './search.js';

const SECTION_PAGES = 25; // Buchseiten je gerendertem Abschnitt (hält das Layout schnell)
const CHARS_PER_MIN = 1300; // ca. 230 Wörter/Minute

const DEFAULTS = {
  fontSize: 19, font: 'literata', lineHeight: 1.55, margin: 'm', align: 'justify', theme: 'paper', mode: 'text', footer: 'page', paraStyle: 'auto',
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
  if (!(await ensureBookAccess(book))) { location.hash = '#/'; return; }
  let pages = await db.getPagesMeta(bookId, { images: false });
  if (!pages.length) { location.hash = `#/book/${bookId}`; return; }
  const profileId = profiles.currentId();
  let state = (await db.getState(profileId, bookId)) || { position: null, bookmarks: [] };
  let lastSavedAt = state.updatedAt || 0;
  // Nur echtes Blättern zählt als neue Leseposition – bloßes Öffnen (oder ein anderes
  // Layout auf diesem Gerät) darf die Position eines anderen Geräts nicht überschreiben.
  let userMoved = false;
  const userNav = () => { userMoved = true; };
  db.updateState(profileId, bookId, { lastOpenedAt: Date.now() }, { touch: false });
  // Lesestatus: beim Öffnen „Lese ich“ (außer schon gelesen)
  let curStatus = state.status || null;
  if (curStatus !== 'done' && curStatus !== 'reading') {
    curStatus = 'reading';
    db.updateState(profileId, bookId, { status: 'reading', statusAt: Date.now() }, { touch: false });
  }

  const settings = loadSettings();
  const pool = new UrlPool();
  let flow = [], cum = [], totalChars = 1, sections = [];
  let figMap = new Map();
  let toc = [];
  let numbers = { labels: [], total: null };
  const figPool = new UrlPool();
  async function loadFigures() {
    figMap = new Map();
    for (const f of await db.getFiguresOfBook(bookId)) {
      if (!figMap.has(f.pageId)) figMap.set(f.pageId, []);
      figMap.get(f.pageId).push(f);
    }
  }
  // „Seite 47“ nach gedruckter Seitenzahl, sonst Position des Fotos
  function pageLabel(pi) {
    const n = numbers.labels[pi];
    if (n) return `Seite ${n}`;
    if (numbers.total) return 'Vorspann';
    return `Seite ${pi + 1}`;
  }
  function pageTotal() { return numbers.total || pages.length; }
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
    iconButton('speaker', 'Vorlesen', () => { closeMenu(); tts.toggle(); }),
    iconButton('list', 'Inhalt, Markierungen & Lesezeichen', () => openContents()),
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
    flow = buildFlow(pages, figMap);
    numbers = displayNumbers(pages);
    cum = new Array(flow.length + 1);
    cum[0] = 0;
    for (let i = 0; i < flow.length; i++) cum[i + 1] = cum[i] + flow[i].weight;
    totalChars = Math.max(1, cum[flow.length]);
    updateParaStyle();
    toc = flow.map((f, fi) => ({ f, fi })).filter(({ f }) => f.block === 'h1' || f.block === 'h2')
      .map(({ f, fi }) => ({ fi, title: f.text, level: f.block === 'h1' ? 0 : 1, pageIndex: f.pageIndex }));
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
    layout();
    figPool.clear();
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      const f = flow[i];
      const prevF = flow[i - 1];
      if (f.figure) { frag.append(figureEl(f, i)); continue; }
      if (f.block === 'table') {
        const blk = parseBlock(f.md);
        frag.append(h('div', { 'data-fi': i, class: 'tbl' }, renderTable(blk)));
        continue;
      }
      if (f.block === 'fn') {
        const el = h('p', { 'data-fi': i, class: 'fn' + (prevF && prevF.block === 'fn' ? '' : ' fn-first') }, h('span', { class: 'fn-label' }, f.label + ' '));
        el.append(renderInline(f.md));
        frag.append(el);
        continue;
      }
      const afterBreak = !prevF || prevF.placeholder || prevF.figure || (prevF.block && prevF.block !== 'p') || i === a;
      let cls = f.placeholder ? 'ph' : f.block === 'h1' || f.block === 'h2' ? f.block : f.block === 'li' ? 'li' + (f.ordered ? ' ol' : '') : afterBreak ? 'first' : '';
      if (f.block === 'li' && (!flow[i + 1] || flow[i + 1].block !== 'li')) cls += ' li-last';
      const el = h('p', { 'data-fi': i, class: cls });
      if (f.block === 'li') el.style.setProperty('--lv', f.level || 0);
      if (f.placeholder) {
        el.append(f.text + ' ');
        el.append(h('button', { class: 'linkish', 'data-show-page': f.pageIndex }, 'Original ansehen'));
      } else if (f.md && f.md !== f.text) {
        el.append(renderInline(f.md));
      } else {
        el.textContent = f.text;
      }
      frag.append(el);
    }
    content.replaceChildren(frag);
    applyHighlights();
    measure();
  }

  // Abbildung mit fester Größe (damit sich das Seitenlayout beim Laden nicht verschiebt)
  function figureEl(f, i) {
    const fig = f.figure;
    const caption = f.caption || fig.caption || '';
    const capH = caption ? Math.round(settings.fontSize * 0.85 * 1.35 * 2 + 8) : 0;
    const maxW = colW, maxH = Math.max(80, colHeight * 0.86 - capH);
    const scale = Math.min(maxW / (fig.w || 1), maxH / (fig.h || 1));
    const w = Math.max(40, Math.round((fig.w || 1) * scale)), hh = Math.max(40, Math.round((fig.h || 1) * scale));
    return h('figure', { class: 'fig', 'data-fi': i, 'data-fig': fig.id },
      h('img', { src: figPool.get(fig.image), alt: caption || 'Abbildung', width: w, height: hh, style: { width: w + 'px', height: hh + 'px' }, draggable: 'false' }),
      caption ? h('figcaption', {}, caption) : null,
    );
  }

  let colHeight = 400;
  let cols = 1, step = 1, frameW = 0;
  // Spaltengeometrie: im Querformat auf großen Bildschirmen zwei Spalten wie ein aufgeschlagenes Buch
  function layout() {
    const m = MARGINS[settings.margin] || 28;
    const W = viewport.clientWidth;
    const H = viewport.clientHeight;
    gap = 2 * m;
    cols = settings.spread !== false && W > H && W >= 820 ? 2 : 1;
    // Zeilen nicht zu lang werden lassen (Tablet/Desktop): max. ca. 34em
    colW = Math.max(200, Math.min((W - 2 * m - gap * (cols - 1)) / cols, Math.round(settings.fontSize * 34)));
    colW = Math.floor(colW);
    frameW = cols * colW + (cols - 1) * gap;
    step = cols * (colW + gap);
    const lh = Math.round(settings.fontSize * settings.lineHeight);
    const vpad = Math.max(12, Math.round(m * 0.5));
    colHeight = Math.max(lh * 3, Math.floor((H - 2 * vpad) / lh) * lh);
  }

  function measure() {
    const m = MARGINS[settings.margin] || 28;
    const W = viewport.clientWidth;
    const H = viewport.clientHeight;
    layout();
    frame.style.left = Math.round((W - frameW) / 2) + 'px';
    frame.style.width = frameW + 'px';
    view.classList.toggle('spread', cols === 2);
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
    screens = Math.max(1, Math.ceil((r.right - base - 1) / step));
  }

  let locateTimer = null;
  function showScreen(n, animate = false) {
    screen = Math.max(0, Math.min(screens - 1, n));
    content.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    content.style.transform = `translateX(${-screen * step}px)`;
    // Während der Animation stimmen Bildschirmkoordinaten nicht → danach messen
    clearTimeout(locateTimer);
    if (animate) locateTimer = setTimeout(updatePositionFromScreen, 200);
    else updatePositionFromScreen();
  }

  // Erste sichtbare Textstelle auf dem aktuellen Bildschirm ermitteln
  function locate(screenNo) {
    const base = content.getBoundingClientRect().left;
    const x0 = screenNo * step;
    const x1 = x0 + frameW;
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
  // Textknoten eines Absatzes (fett/kursiv erzeugt mehrere) mit fortlaufenden Zeichenpositionen
  function textNodes(el) {
    const nodes = [];
    let total = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement && n.parentElement.closest('button')) continue;
      nodes.push({ n, start: total });
      total += n.length;
    }
    return { nodes, total };
  }
  function nodeAt(tn, off) {
    let k = tn.nodes.length - 1;
    while (k > 0 && tn.nodes[k].start > off) k--;
    const e = tn.nodes[k];
    return e ? { node: e.n, off: Math.min(off - e.start, e.n.length - 1) } : null;
  }

  // Erstes Zeichen des Absatzes, das in der Spalte ab x0 steht (binäre Suche über Zeichen-Rechtecke).
  // Unabhängig von Menüs/Overlays, die über dem Text liegen könnten.
  function charAtColumn(el, x0) {
    const tn = textNodes(el);
    if (!tn.total) return 0;
    const base = content.getBoundingClientRect().left;
    const r = document.createRange();
    const leftOf = (i) => {
      const at = nodeAt(tn, i);
      r.setStart(at.node, at.off); r.setEnd(at.node, at.off + 1);
      const rc = r.getClientRects()[0] || r.getBoundingClientRect();
      return rc.left - base;
    };
    let lo = 0, hi = tn.total - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (leftOf(mid) >= x0 - 1) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    // Leerzeichen am Spaltenanfang überspringen
    const charAt = (i) => { const at = nodeAt(tn, i); return at.node.data[at.off]; };
    while (ans < tn.total - 1 && /\s/.test(charAt(ans))) ans++;
    return ans;
  }

  function screenOfChar(fi, char) {
    const el = content.querySelector(`[data-fi="${fi}"]`);
    if (!el) return 0;
    const base = content.getBoundingClientRect().left;
    let rect = null;
    if (char > 0) {
      const tn = textNodes(el);
      if (tn.total) {
        const at = nodeAt(tn, Math.min(char, tn.total - 1));
        const r = document.createRange();
        r.setStart(at.node, Math.max(0, at.off));
        r.setEnd(at.node, Math.max(0, at.off) + 1);
        rect = r.getClientRects()[0] || null;
      }
    }
    if (!rect) rect = el.getClientRects()[0];
    if (!rect) return 0;
    return Math.max(0, Math.floor((rect.left - base + 1) / step));
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
    const noImg = () => h('div', { class: 'r-noimage' }, h('p', {}, `Seite ${imgIndex + 1}`), h('p', { class: 'muted small' }, 'Das Originalfoto liegt nur auf dem Gerät, mit dem die Seite gescannt wurde (oder es wurde gelöscht). Synchronisiert wird ohne „Fotos mitsichern“ nur der Text.'));
    if (p.image) imgView.replaceChildren(h('img', { src: pool.get(p.image), alt: `Seite ${imgIndex + 1}`, draggable: 'false' }));
    else if (p.hasImage) {
      // verschlüsseltes Foto erst beim Anzeigen entschlüsseln
      imgView.replaceChildren(h('div', { class: 'r-noimage' }, h('span', { class: 'spinner' })));
      const want = imgIndex;
      db.pageImage(p).then((blob) => { if (imgIndex !== want) return; imgView.replaceChildren(blob ? h('img', { src: pool.get(blob), alt: `Seite ${want + 1}`, draggable: 'false' }) : noImg()); });
    } else imgView.replaceChildren(noImg());
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
    recordActivity();
    import('./stats.js').then((m) => m.addTurn(profileId)).catch(() => {});
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
    recordActivity();
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
      // Bis zum Ende gelesen → „Gelesen“
      if (pos && userMoved && (pos.ratio || 0) >= 0.995 && curStatus !== 'done') {
        curStatus = 'done';
        db.updateState(profileId, bookId, { status: 'done', statusAt: Date.now() }, { touch: false });
        toast('Ende erreicht – als „Gelesen“ markiert', 3500);
      }
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
    const pi = pos.pageIndex ?? 0;
    const left = (1 - (pos.ratio || 0)) * totalChars / CHARS_PER_MIN;
    const leftTxt = left < 1 ? 'weniger als 1 Min.' : left < 60 ? `${Math.round(left)} Min.` : `${Math.floor(left / 60)} Std. ${Math.round(left % 60)} Min.`;
    const fmtMin = (mins) => (mins < 1 ? 'weniger als 1 Min.' : mins < 60 ? `${Math.round(mins)} Min.` : `${Math.floor(mins / 60)} Std. ${Math.round(mins % 60)} Min.`);
    let chapterTxt = '';
    if (toc.length && settings.mode === 'text') {
      const fiNow = flowIndexFor(pos);
      const nextH = toc.find((t) => t.fi > fiNow);
      const end = nextH ? cum[nextH.fi] : totalChars;
      chapterTxt = `Noch ${fmtMin(Math.max(0, end - (cum[fiNow] + (pos.char || 0))) / CHARS_PER_MIN)} im Kapitel`;
    }
    footLeft.textContent = settings.footer === 'time'
      ? `Noch ${leftTxt} im Buch`
      : settings.footer === 'chapter' && chapterTxt ? chapterTxt
        : settings.footer === 'none' ? '' : `${pageLabel(pi)} von ${pageTotal()}`;
    sliderLabel.textContent = `${pageLabel(pi)} von ${pageTotal()} · ${pct} %`;
  }
  function cycleFooter() {
    settings.footer = { page: toc.length ? 'chapter' : 'time', chapter: 'time', time: 'none', none: 'page' }[settings.footer] || 'page';
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
      const snippet = settings.mode === 'images' ? `${pageLabel(imgIndex)} (Original)`
        : f.figure ? 'Abbildung' + (f.figure.caption ? ': ' + f.figure.caption : '')
          : f.text.slice(pos.char || 0, (pos.char || 0) + 90).trim() + '…';
      bms.push({ ...pos, label: snippet, createdAt: Date.now(), image: settings.mode === 'images', pageIndex: pos.pageIndex });
      toast('Lesezeichen gesetzt');
    }
    state = await db.updateState(profileId, bookId, { bookmarks: bms });
    updateBookmarkState();
  }

  // ---------- Inhalt (Lesezeichen & Seiten) ----------
  function openContents(initial) {
    const list = h('div', { class: 'stack' });
    const tabs = h('div', { class: 'segmented' });
    const thumbPool = new UrlPool();
    const show = (which) => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === which));
      thumbPool.clear();
      if (which === 'toc') {
        const cur = flowIndexFor(pos);
        let curIdx = -1;
        toc.forEach((t, i) => { if (t.fi <= cur) curIdx = i; });
        list.replaceChildren(h('div', { class: 'toc' }, ...toc.map((t, i) => h('button', {
          class: 'toc-item lv' + t.level + (i === curIdx ? ' current' : ''),
          onClick: () => { s.close(); userNav(); closeMenu(); if (settings.mode !== 'text') switchModeTo('text', t.pageIndex); goToFlow(t.fi, 0); },
        }, h('span', { class: 'grow' }, t.title), h('span', { class: 'muted small' }, pageLabel(t.pageIndex).replace('Seite ', 'S. '))))));
      } else if (which === 'hl') {
        const hls = liveHighlights().sort((a, b) => hlGlobal(a) - hlGlobal(b));
        list.replaceChildren(
          hls.length ? h('div', { class: 'row gap-s wrap' },
            h('a', { class: 'btn small primary', href: '#/lernen/' + bookId, onClick: () => s.close() }, icon('cards'), 'Lernkarten üben'),
            h('button', { class: 'btn small', onClick: () => exportHighlights() }, icon('download'), 'Exportieren (.md)')) : null,
          ...(hls.length ? hls.map((hl) => h('button', { class: 'menu-item multi hl-item', onClick: () => { s.close(); jumpToHighlight(hl); } },
            h('span', { class: 'hl-dot c-' + hl.color }),
            h('span', {},
              h('span', { class: 'small muted' }, pageLabel(hlPageIndex(hl))), h('br'),
              h('span', { class: 'hl-quote' }, hl.text.length > 220 ? hl.text.slice(0, 220) + '…' : hl.text),
              hl.note ? [h('br'), h('span', { class: 'hl-note' }, icon('note'), hl.note)] : null,
            ),
          )) : [h('p', { class: 'muted' }, 'Noch keine Markierungen. Text lange antippen bzw. markieren und eine Farbe wählen.')]),
        );
      } else if (which === 'bm') {
        const bms = [...(state.bookmarks || [])].sort((a, b) => globalOf(a) - globalOf(b));
        list.replaceChildren(...(bms.length ? bms.map((b) => h('button', { class: 'menu-item multi', onClick: () => { s.close(); jumpTo(b); } },
          icon('bookmark'),
          h('span', {}, h('span', { class: 'small muted' }, `${pageLabel(b.pageIndex ?? 0)} · ${Math.round((b.ratio || 0) * 100)} %`), h('br'), b.label),
        )) : [h('p', { class: 'muted' }, 'Noch keine Lesezeichen. Tippe oben auf das Lesezeichen-Symbol, um eins zu setzen.')]));
      } else {
        list.replaceChildren(h('div', { class: 'pages-grid compact' }, ...pages.map((p, i) => h('button', {
          class: 'page-tile' + (i === (pos?.pageIndex ?? -1) ? ' current' : ''),
          onClick: () => { s.close(); jumpToPage(i); },
        }, p.thumb ? h('img', { src: thumbPool.get(p.thumb), alt: '', loading: 'lazy' }) : h('span', { class: 'page-textthumb' }, (p.text || '').slice(0, 160)),
        h('span', { class: 'page-no' }, numbers.labels[i] || i + 1)))));
      }
    };
    if (toc.length) tabs.append(h('button', { 'data-t': 'toc', onClick: () => show('toc') }, 'Inhalt'));
    tabs.append(
      h('button', { 'data-t': 'hl', onClick: () => show('hl') }, 'Markiert'),
      h('button', { 'data-t': 'bm', onClick: () => show('bm') }, 'Lesez.'),
      h('button', { 'data-t': 'pages', onClick: () => show('pages') }, 'Seiten'),
    );
    const s = sheet('Inhalt', h('div', { class: 'stack' }, tabs, list), { onClose: () => thumbPool.clear() });
    show(initial || (toc.length ? 'toc' : liveHighlights().length ? 'hl' : (state.bookmarks || []).length ? 'bm' : 'pages'));
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
              h('span', { class: 'small muted' }, pageLabel(sourcePageAt(fi, char))), h('br'),
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
  // Absätze: Einzug (Roman) oder Abstand (Fachtext); automatisch je nach Inhalt
  function updateParaStyle() {
    const structured = flow.some((f) => f.block && f.block !== 'p');
    content.classList.toggle('para-space', settings.paraStyle === 'space' || (settings.paraStyle === 'auto' && structured));
  }

  function applySettings() {
    view.dataset.theme = settings.theme;
    content.style.fontFamily = (FONTS[settings.font] || FONTS.literata).css;
    content.style.fontSize = settings.fontSize + 'px';
    content.style.lineHeight = String(settings.lineHeight);
    content.style.textAlign = settings.align;
    updateParaStyle();
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
      h('strong', {}, 'Absätze'), seg('paraStyle', { auto: 'Automatisch', indent: 'Einzug', space: 'Abstand' }),
      h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Zwei Spalten im Querformat'), h('br'), h('span', { class: 'muted small' }, 'Auf dem Tablet wie ein aufgeschlagenes Buch')),
        h('input', { type: 'checkbox', checked: settings.spread !== false, onChange: (e) => { settings.spread = e.target.checked; saveSettings(settings); relayout(); } })),
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

  // ---------- Markierungen & Notizen ----------
  // Markierung: { id, segs: [{ pageId, p, start, end }], text, color, note, createdAt, updatedAt, deleted? }
  const HL_COLORS = { yellow: 'Gelb', green: 'Grün', blue: 'Blau', pink: 'Rosa' };
  const liveHighlights = () => (state.highlights || []).filter((x) => !x.deleted);
  const flowIndexExact = (seg) => {
    let fi = flow.findIndex((f) => f.pageId === seg.pageId && f.p === seg.p);
    return fi;
  };
  const hlGlobal = (hl) => { const sg = hl.segs[0]; const fi = flowIndexExact(sg); return fi < 0 ? Infinity : cum[fi] + sg.start; };
  const hlPageIndex = (hl) => { const sg = hl.segs[0]; const fi = flowIndexExact(sg); return fi < 0 ? 0 : sourcePageAt(fi, sg.start); };

  function charOffsetIn(el, node, offset) {
    if (!el.contains(node)) return node.compareDocumentPosition && (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) ? textNodes(el).total : 0;
    const r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  // Textbereich [start, end) eines Absatzes mit <mark> umschließen (über fett/kursiv hinweg)
  function wrapRange(el, start, end, attrs) {
    const tn = textNodes(el);
    for (const { n, start: s0 } of tn.nodes) {
      const a = Math.max(start, s0), b = Math.min(end, s0 + n.length);
      if (a >= b) continue;
      let node = n;
      if (b < s0 + node.length) node.splitText(b - s0);
      if (a > s0) node = node.splitText(a - s0);
      const m = document.createElement('mark');
      for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
      node.parentNode.insertBefore(m, node);
      m.append(node);
    }
  }

  function applyHighlights() {
    if (sectionIdx < 0 || !sections[sectionIdx]) return;
    const [a, b] = sections[sectionIdx];
    for (const hl of liveHighlights()) {
      for (const sg of hl.segs) {
        const fi = flowIndexExact(sg);
        if (fi < a || fi >= b) continue;
        const el = content.querySelector(`[data-fi="${fi}"]`);
        if (!el || el.tagName === 'FIGURE') continue;
        wrapRange(el, sg.start, sg.end, { class: 'hl c-' + hl.color + (hl.note ? ' has-note' : ''), 'data-hl': hl.id });
      }
    }
  }

  function rerenderKeepScreen() {
    const keep = screen;
    if (sectionIdx < 0) return;
    renderSection(sectionIdx);
    showScreen(Math.min(keep, screens - 1));
  }

  async function saveHighlights(list) {
    state = await db.updateState(profileId, bookId, { highlights: list });
    lastSavedAt = Date.now();
  }

  // Schwebende Leiste über der Textauswahl
  const hlBar = h('div', { class: 'hl-bar', hidden: true },
    ...Object.entries(HL_COLORS).map(([c, label]) => h('button', { class: 'hl-dot-btn c-' + c, 'aria-label': 'Markieren: ' + label, onClick: () => createHighlight(c) })),
    h('button', { class: 'hl-bar-btn', onClick: () => createHighlight('yellow', true) }, icon('note'), 'Notiz'),
    h('button', { class: 'hl-bar-btn', onClick: () => { navigator.clipboard && navigator.clipboard.writeText(String(window.getSelection())); toast('Kopiert'); hideHlBar(); } }, 'Kopieren'),
    h('button', { class: 'hl-bar-btn', 'aria-label': 'Nachschlagen', onClick: async () => {
      const term = String(window.getSelection()).trim();
      hideHlBar();
      const { openLookup } = await import('./lookup.js');
      openLookup(term.split(/\s+/).length > 4 ? term.split(/\s+/).slice(0, 4).join(' ') : term, {
        // Wo kommt das Wort sonst im Buch vor? (funktioniert offline, z. B. für Namen)
        occurrences: (t) => {
          const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(^|[^\\p{L}])(${esc})(?![\\p{L}])`, 'iu');
          const out = [];
          for (let fi = 0; fi < flow.length && out.length < 6; fi++) {
            const tx = flow[fi].text;
            if (!tx) continue;
            const m = tx.match(re);
            if (!m) continue;
            const i = m.index + m[1].length;
            out.push({ before: (i > 50 ? '…' : '') + tx.slice(Math.max(0, i - 50), i), word: m[2], after: tx.slice(i + m[2].length, i + m[2].length + 50) + '…', go: () => goToFlow(fi, i) });
          }
          return out;
        },
      });
    } }, icon('globe'), 'Nachschlagen'),
  );
  view.append(hlBar);
  function hideHlBar() { hlBar.hidden = true; }
  let selTimer = null;
  const onSel = () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !content.contains(sel.anchorNode) || settings.mode !== 'text') { hideHlBar(); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const vr = view.getBoundingClientRect();
      hlBar.hidden = false;
      const bw = hlBar.offsetWidth || 280;
      hlBar.style.left = Math.max(8, Math.min(vr.width - bw - 8, r.left + r.width / 2 - bw / 2 - vr.left)) + 'px';
      const above = r.top - vr.top - 56;
      hlBar.style.top = (above > 40 ? above : r.bottom - vr.top + 12) + 'px';
    }, 200);
  };
  document.addEventListener('selectionchange', onSel);

  async function createHighlight(color, withNote = false) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer).closest('[data-fi]');
    const endEl = (range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer).closest('[data-fi]');
    if (!startEl || !endEl) return;
    const fa = +startEl.dataset.fi, fb = +endEl.dataset.fi;
    const segs = [];
    for (let fi = fa; fi <= fb; fi++) {
      const f = flow[fi];
      const el = content.querySelector(`[data-fi="${fi}"]`);
      if (!f || f.figure || f.placeholder || !el) continue;
      const len = textNodes(el).total;
      const st = fi === fa ? charOffsetIn(el, range.startContainer, range.startOffset) : 0;
      const en = fi === fb ? charOffsetIn(el, range.endContainer, range.endOffset) : len;
      if (en > st) segs.push({ pageId: f.pageId, p: f.p, start: st, end: en });
    }
    if (!segs.length) return;
    const now = Date.now();
    const hl = { id: db.uid(), segs, text: String(sel).trim(), color, note: '', createdAt: now, updatedAt: now };
    sel.removeAllRanges();
    hideHlBar();
    await saveHighlights([...(state.highlights || []), hl]);
    rerenderKeepScreen();
    if (withNote) openHighlight(hl.id, true);
    else toast('Markiert');
  }

  function openHighlight(id, focusNote = false) {
    const hl = (state.highlights || []).find((x) => x.id === id);
    if (!hl) return;
    let color = hl.color;
    const note = h('textarea', { class: 'input', rows: 3, placeholder: 'Notiz (optional)' });
    note.value = hl.note || '';
    const colorRow = h('div', { class: 'row gap-s' });
    const paint = () => colorRow.replaceChildren(...Object.entries(HL_COLORS).map(([c, label]) => h('button', { type: 'button', class: 'hl-dot-btn c-' + c + (c === color ? ' on' : ''), 'aria-label': label, onClick: () => { color = c; paint(); } })));
    paint();
    const update = async (patch) => {
      const list = (state.highlights || []).map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x));
      await saveHighlights(list);
      rerenderKeepScreen();
    };
    const sh = sheet('Markierung', h('div', { class: 'stack' },
      h('blockquote', { class: 'hl-quote-big c-' + hl.color }, hl.text),
      colorRow, note,
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn primary', onClick: async () => { await update({ color, note: note.value.trim() }); sh.close(); } }, 'Speichern'),
        h('button', { class: 'btn', onClick: () => { navigator.clipboard && navigator.clipboard.writeText(hl.text + (note.value ? '\n\nNotiz: ' + note.value : '')); toast('Kopiert'); } }, 'Kopieren'),
        h('button', { class: 'btn danger', onClick: async () => { await update({ deleted: true }); sh.close(); toast('Markierung entfernt'); } }, icon('trash'), 'Entfernen'),
      ),
    ));
    if (focusNote) setTimeout(() => note.focus(), 250);
  }

  function jumpToHighlight(hl) {
    const sg = hl.segs[0];
    const fi = flowIndexExact(sg);
    if (fi < 0) { toast('Stelle nicht mehr vorhanden'); return; }
    userNav(); closeMenu();
    if (settings.mode !== 'text') { settings.mode = 'text'; saveSettings(settings); applySettings(); sectionIdx = -1; }
    goToFlow(fi, sg.start);
  }

  function exportHighlights() {
    const lines = [`# ${book.title}${book.author ? ' – ' + book.author : ''}`, '', `Markierungen und Notizen · exportiert am ${new Date().toLocaleDateString('de-DE')}`, ''];
    for (const hl of liveHighlights().sort((a, b) => hlGlobal(a) - hlGlobal(b))) {
      lines.push(`> ${hl.text.replace(/\n+/g, ' ')}`, '');
      if (hl.note) lines.push(`**Notiz:** ${hl.note}`, '');
      lines.push(`— ${pageLabel(hlPageIndex(hl))} · ${HL_COLORS[hl.color] || ''}`, '', '---', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    download(blob, safeName(book.title) + ' - Markierungen.md');
  }

  // ---------- Vorlesen (Sprachausgabe des Geräts) ----------
  const tts = (() => {
    const synth = window.speechSynthesis;
    let active = false, cur = null; // cur = { fi, char }
    let utter = null, chunkBase = 0, chunkFi = -1;
    const bar = h('div', { class: 'tts-bar', hidden: true });
    const rateBtn = h('button', { class: 'tts-rate', onClick: () => cycleRate() });
    const playBtn = iconButton('pause', 'Pause', () => (active ? pause() : play()));
    // Schlaf-Timer: nach X Minuten oder am Kapitelende aufhören
    let sleep = null; // { until } | { chapter: true, fromFi }
    let sleepTimer = null, sleepTick = null;
    const sleepBtn = h('button', { class: 'tts-sleep', 'aria-label': 'Schlaf-Timer', onClick: () => openSleep() }, icon('moon'), h('span', {}, ''));
    const sleepLabel = () => {
      const lbl = sleepBtn.lastChild;
      if (!sleep) { lbl.textContent = ''; sleepBtn.classList.remove('on'); sleepBtn.setAttribute('aria-label', 'Schlaf-Timer'); return; }
      sleepBtn.classList.add('on');
      lbl.textContent = sleep.chapter ? 'Kap.' : Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000)) + "'";
      sleepBtn.setAttribute('aria-label', sleep.chapter ? 'Schlaf-Timer: bis Kapitelende' : `Schlaf-Timer: noch ${lbl.textContent.replace("'", '')} Minuten`);
    };
    function setSleep(v) {
      clearTimeout(sleepTimer); clearInterval(sleepTick);
      sleep = v;
      if (v && v.until) {
        sleepTimer = setTimeout(() => sleepNow(), v.until - Date.now());
        sleepTick = setInterval(sleepLabel, 20000);
      }
      sleepLabel();
    }
    function sleepNow() {
      setSleep(null);
      stop();
      toast('Schlaf-Timer: Vorlesen beendet', 4000);
    }
    function openSleep() {
      const opts = [[0, 'Aus'], [5, '5 Min.'], [15, '15 Min.'], [30, '30 Min.'], [45, '45 Min.'], [60, '60 Min.'], ['chapter', 'Ende des Kapitels']];
      const sh = sheet('Schlaf-Timer', h('div', { class: 'menu' }, ...opts.map(([v, label]) => h('button', {
        class: 'menu-item' + ((!sleep && v === 0) || (sleep && sleep.chapter && v === 'chapter') ? ' current' : ''),
        onClick: () => {
          sh.close();
          if (!v) { setSleep(null); toast('Schlaf-Timer aus'); return; }
          if (v === 'chapter') setSleep({ chapter: true, fromFi: cur ? cur.fi : locate(screen).fi });
          else setSleep({ until: Date.now() + v * 60000 });
          toast(v === 'chapter' ? 'Vorlesen endet am Kapitelende' : `Vorlesen endet in ${v} Minuten`);
          if (!active) play();
        },
      }, icon(v ? 'moon' : 'close'), label))));
    }
    const voiceBtn = h('button', { class: 'tts-voice grow', 'aria-label': 'Stimme wählen', onClick: () => openVoices() }, icon('speaker'), h('span', { class: 'tts-label' }, 'Vorlesen'));
    bar.append(voiceBtn, sleepBtn, rateBtn, playBtn, iconButton('stop', 'Vorlesen beenden', () => stop()));
    view.append(bar);
    const rateTxt = () => (settings.ttsRate || 1).toLocaleString('de-DE', { minimumFractionDigits: 1 }) + '×';
    rateBtn.textContent = rateTxt();
    // Qualität einer Stimme: Premium > Erweitert > Standard (iOS nennt sie „Anna (Premium)“,
    // „Anna (Erweitert)“, die voiceURI enthält „premium“ bzw. „enhanced“)
    const quality = (v) => {
      const s = (v.name + ' ' + (v.voiceURI || '')).toLowerCase();
      if (/premium/.test(s)) return 3;
      if (/enhanced|erweitert|neural|natural/.test(s)) return 2;
      if (/eloquence|compact|kompakt|grandma|grandpa|oma|opa|rocko|shelley|sandy|reed|flo|eddy/.test(s)) return 0;
      return 1;
    };
    const QUALITY = ['Einfach', 'Standard', 'Erweitert', 'Premium'];
    function voices() {
      const all = synth.getVoices().filter((v) => /^de(-|_|$)/i.test(v.lang));
      // Stimmen auf dem Gerät bevorzugen (Online-Stimmen schicken den Text an den Anbieter)
      const local = all.filter((v) => v.localService !== false);
      return (local.length ? local : all).sort((a, b) => quality(b) - quality(a) || (/de-DE/i.test(b.lang) - /de-DE/i.test(a.lang)) || a.name.localeCompare(b.name));
    }
    // „Systemstimme“: keine Stimme vorgeben, nur die Sprache – das Gerät nimmt dann seine
    // Standardstimme (auf manchen Geräten die in den Einstellungen gewählte)
    const SYSTEM = 'system';
    const useSystem = () => settings.ttsVoice === SYSTEM;
    function voice() {
      if (useSystem() || engineIsPiper()) return null;
      const vs = voices();
      return (settings.ttsVoice && vs.find((v) => (v.voiceURI || v.name) === settings.ttsVoice)) || vs[0] || null;
    }
    const shortName = (v) => v.name.replace(/\s*\(.*\)\s*$/, '').replace(/^.*\.([^.]+)$/, '$1');
    function voiceLabel() {
      const v = voice();
      if (engineIsPiper()) { voiceBtn.lastChild.textContent = (piperMod && piperMod.VOICES[piperId()] ? piperMod.VOICES[piperId()].name : 'Eigene Stimme'); if (!piperMod) piper().then(() => voiceLabel()); return; }
      voiceBtn.lastChild.textContent = useSystem() ? 'Systemstimme' : v ? shortName(v) : 'Vorlesen';
    }
    function sample(v) {
      stopPiper();
      if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance('Hallo, so klinge ich, wenn ich dir dein Buch vorlese.');
      u.lang = 'de-DE'; if (v) u.voice = v; u.rate = settings.ttsRate || 1;
      synth.speak(u);
    }
    function openVoices() {
      const wasActive = active;
      if (active) pause();
      const vs = voices();
      const sel = voice();
      const entries = [{ system: true }, ...vs];
      const isSel = (e) => (e.system ? useSystem() : !useSystem() && !engineIsPiper() && sel === e);
      const list = h('div', { class: 'menu' }, entries.map((e, i) => h('button', {
        class: 'menu-item voice-item' + (isSel(e) ? ' current' : ''),
        onClick: () => {
          settings.ttsVoice = e.system ? SYSTEM : e.voiceURI || e.name;
          saveSettings(settings);
          document.querySelectorAll('.sheet .current').forEach((x) => x.classList.remove('current'));
          list.querySelectorAll('.voice-item')[i].classList.add('current');
          voiceLabel();
          sample(e.system ? null : e);
        },
      }, icon('speaker'), h('span', { class: 'grow' }, e.system ? 'Systemstimme' : shortName(e)),
      e.system ? h('span', { class: 'voice-q' }, 'Gerät') : h('span', { class: 'voice-q q' + quality(e) }, QUALITY[quality(e)]))));
      // iOS/Safari reicht selbst geladene Premium-Stimmen nicht an Web-Apps weiter
      const onlySimple = !vs.some((v) => quality(v) >= 2);
      const note = onlySimple ? h('p', { class: 'small muted' }, 'Hier erscheinen nur die Stimmen, die der Browser freigibt. Safari auf iPhone/iPad gibt selbst geladene Premium-Stimmen (z. B. „Petra (Premium)“) nicht an Web-Apps weiter. Probier „Systemstimme“: Manche Geräte lesen dann mit der Stimme aus den Einstellungen vor.') : null;
      const help = h('details', { class: 'voice-help' },
        h('summary', {}, 'Bessere Stimmen laden'),
        h('p', { class: 'small' }, 'Die Stimmen kommen vom Gerät. Die besten heißen „Premium“ oder „Erweitert“ und müssen einmal geladen werden (kostenlos, je nach Stimme ca. 100–400 MB):'),
        h('p', { class: 'small' }, h('b', {}, 'iPhone/iPad: '), 'Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch → z. B. „Anna“, „Petra“ oder „Yannick“ → die Premium- bzw. Erweitert-Variante laden. Danach Lesepixel neu öffnen. Ob Safari sie an Lesepixel weitergibt, entscheidet Apple.'),
        h('p', { class: 'small' }, h('b', {}, 'Android: '), 'Einstellungen → Bedienungshilfen → Sprachausgabe (Text-in-Sprache) → Google-Sprachausgabe → Sprachdaten installieren → Deutsch, dort eine Stimme wählen.'),
        h('p', { class: 'small muted' }, 'Die Siri-Stimmen gibt Apple für Web-Apps leider nicht frei.'));
      const own = h('div', { class: 'stack own-voices' });
      sheet('Stimme', h('div', { class: 'stack' }, own, h('h4', { class: 'voice-head' }, 'Stimmen des Geräts'), list, note, help), { onClose: () => { stopPiper(); if (synth) synth.cancel(); if (wasActive) play(); } });
      renderOwnVoices(own);
    }
    // Eigene Stimmen (Piper): laden, wählen, löschen
    async function renderOwnVoices(box) {
      const m = await piper();
      if (!m.supported()) { box.remove(); return; }
      const have = new Set(await m.installed());
      const rows = Object.entries(m.VOICES).map(([id, v]) => {
        const isCur = engineIsPiper() && piperId() === id;
        const status = h('span', { class: 'voice-q' + (have.has(id) ? ' q3' : '') }, have.has(id) ? 'Geladen' : `${v.mb} MB`);
        const prog = h('div', { class: 'progress', hidden: true }, h('div', { style: { width: '0%' } }));
        const row = h('div', { class: 'own-voice' });
        const choose = async () => {
          unlockAudio(); // noch in der Tipp-Geste (iOS)
          if (!have.has(id)) {
            if (!navigator.onLine) { toast('Zum Laden der Stimme ist Internet nötig'); return; }
            prog.hidden = false; status.textContent = '0 %';
            try {
              await m.install(id, (x) => { prog.firstChild.style.width = Math.round(x * 100) + '%'; status.textContent = Math.round(x * 100) + ' %'; });
              try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* */ }
            } catch (e) {
              console.warn(e); prog.hidden = true; status.textContent = `${v.mb} MB`;
              toast('Laden fehlgeschlagen – bitte später noch einmal versuchen'); return;
            }
            prog.hidden = true;
            have.add(id); status.textContent = 'Geladen'; status.classList.add('q3');
            del.hidden = false;
          }
          settings.ttsVoice = 'piper:' + id;
          saveSettings(settings);
          document.querySelectorAll('.sheet .current').forEach((x) => x.classList.remove('current'));
          btn.classList.add('current');
          voiceLabel();
          if (synth) synth.cancel();
          stopPiper();
          const gen = ++piperGen;
          toast('Stimme wird vorbereitet …', 1500);
          try {
            const audio = await piperAudio('Hallo, so klinge ich, wenn ich dir dein Buch vorlese.');
            if (gen === piperGen) piperPlay = m.play(audio);
          } catch (e) { console.warn(e); toast('Die Stimme konnte nicht sprechen'); }
        };
        const btn = h('button', { class: 'menu-item voice-item' + (isCur ? ' current' : ''), onClick: choose },
          icon('speaker'), h('span', { class: 'grow' }, h('span', {}, v.name), h('span', { class: 'muted small voice-desc' }, v.desc)), status);
        const del = iconButton('trash', 'Stimme löschen', async () => {
          await m.remove(id); have.delete(id);
          status.textContent = `${v.mb} MB`; status.classList.remove('q3'); del.hidden = true;
          if (piperId() === id && engineIsPiper()) { settings.ttsVoice = ''; saveSettings(settings); btn.classList.remove('current'); voiceLabel(); }
          toast('Stimme gelöscht');
        });
        del.hidden = !have.has(id);
        row.append(btn, del);
        return h('div', {}, row, prog);
      });
      box.append(h('h4', { class: 'voice-head' }, 'Eigene Stimmen (natürlicher)'),
        h('p', { class: 'small muted' }, 'Laufen direkt auf dem Gerät, auch offline. Einmal laden (Internet nötig, dabei wird nur die Stimme heruntergeladen, kein Text gesendet).'),
        h('div', { class: 'menu' }, rows));
    }
    // Stimmen werden auf manchen Geräten erst nach und nach geladen
    try { if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', () => { if (!bar.hidden) voiceLabel(); }); } catch (e) { /* */ }
    function cycleRate() {
      const rates = [0.8, 1, 1.2, 1.4, 1.7];
      const i = rates.indexOf(settings.ttsRate || 1);
      settings.ttsRate = rates[(i + 1) % rates.length];
      saveSettings(settings);
      rateBtn.textContent = rateTxt();
      if (active) { if (utter) utter.__cancelled = true; stopPiper(); if (synth) synth.cancel(); speakFrom(cur); }
    }
    function markSpeaking(fi) {
      content.querySelectorAll('.speaking').forEach((e) => e.classList.remove('speaking'));
      const el = content.querySelector(`[data-fi="${fi}"]`);
      if (el) el.classList.add('speaking');
    }
    function follow(fi, char) {
      // Seite umblättern, sobald die gesprochene Stelle nicht mehr sichtbar ist
      if (settings.mode !== 'text') return;
      if (sectionOf(fi) !== sectionIdx) { goToFlow(fi, char); markSpeaking(fi); return; }
      const sc = screenOfChar(fi, char);
      if (sc !== screen) showScreen(sc, true);
    }
    // Nächstes Stück Text ab einer Stelle (Sätze bis ca. 280 Zeichen; lange Äußerungen
    // brechen auf manchen Geräten ab, und die eigene Stimme braucht kurze Stücke)
    function pieceAt(at) {
      let { fi, char } = at;
      while (fi < flow.length && (flow[fi].placeholder || (flow[fi].figure && !flow[fi].caption))) { fi++; char = 0; }
      if (fi >= flow.length) return null;
      const f = flow[fi];
      const text = f.figure ? 'Abbildung: ' + f.caption : f.text;
      // eigene Stimme: kurze Stücke, das erste besonders kurz (schneller Start)
      const max = engineIsPiper() ? (piperFirst ? 90 : 160) : 280;
      let end = Math.min(text.length, char + max);
      if (end < text.length) {
        const sub = text.slice(char, end);
        const m = sub.match(/^[\s\S]*[.!?…:;](?=\s)/);
        if (m && m[0].length > 30) end = char + m[0].length;
        else { const sp = sub.lastIndexOf(' '); if (sp > 30) end = char + sp; }
      }
      const next = end >= text.length ? { fi: fi + 1, char: 0 } : { fi, char: end + (text[end] === ' ' ? 1 : 0) };
      return { fi, char, f, text, end, piece: text.slice(char, end), next };
    }
    function speakFrom(at) {
      const pc = pieceAt(at);
      if (!pc) { stop(); toast('Ende des Buchs'); return; }
      const { fi, char, f, piece, next } = pc;
      // Schlaf-Timer „Kapitelende“: nächste Kapitelüberschrift erreicht
      if (sleep && sleep.chapter && fi > sleep.fromFi && (flow[fi].block === 'h1' || (flow[fi].block === 'h2' && !toc.some((t) => t.level === 0)))) { sleepNow(); return; }
      cur = { fi, char };
      chunkFi = fi; chunkBase = char;
      markSpeaking(fi);
      follow(fi, char);
      recordActivity();
      const onWord = (ci) => {
        cur = { fi: chunkFi, char: chunkBase + ci };
        if (!f.figure) follow(chunkFi, cur.char);
      };
      if (engineIsPiper()) { speakPiper(piece, onWord, next); return; }
      utter = new SpeechSynthesisUtterance(piece);
      utter.lang = 'de-DE';
      const v = voice(); if (v) utter.voice = v;
      utter.rate = settings.ttsRate || 1;
      utter.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        onWord(e.charIndex);
      };
      utter.onend = () => {
        if (!active || utter.__cancelled) return;
        speakFrom(next);
      };
      utter.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') { console.warn('TTS', e.error); } };
      synth.speak(utter);
    }

    // ---- Eigene Stimme (Piper, läuft auf dem Gerät) ----
    let piperMod = null, piperGen = 0, piperPlay = null, piperTick = null, piperFirst = false;
    const piperCache = new Map(); // key → Promise<audio>
    const piperId = () => (settings.ttsVoice || '').slice(6);
    // Ton auf iOS freigeben – synchron im Tipp-Handler, gleicher AudioContext wie piper.js
    function unlockAudio() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!window.__obAudio) window.__obAudio = new AC();
        const ac = window.__obAudio;
        if (ac.state !== 'running') ac.resume().catch(() => {});
        const b = ac.createBuffer(1, 1, 22050);
        const src = ac.createBufferSource();
        src.buffer = b; src.connect(ac.destination); src.start(0);
      } catch (e) { /* */ }
    }
    function engineIsPiper() { return /^piper:/.test(settings.ttsVoice || ''); }
    async function piper() { if (!piperMod) piperMod = await import('./piper.js'); return piperMod; }
    function piperAudio(text) {
      const key = piperId() + '|' + (settings.ttsRate || 1) + '|' + text;
      if (!piperCache.has(key)) {
        piperCache.set(key, piper().then((m) => m.synthesize(piperId(), text, { rate: settings.ttsRate || 1 })));
        while (piperCache.size > 6) piperCache.delete(piperCache.keys().next().value);
      }
      return piperCache.get(key);
    }
    function stopPiper() {
      piperGen++;
      clearInterval(piperTick);
      if (piperPlay) { piperPlay.stop(); piperPlay = null; }
    }
    async function speakPiper(piece, onWord, next) {
      const gen = ++piperGen;
      const first = piperFirst;
      piperFirst = false;
      let audio;
      const slow = first ? setTimeout(() => { if (gen === piperGen) toast('Stimme wird vorbereitet …', 2500); }, 700) : null;
      try {
        audio = await piperAudio(piece);
        clearTimeout(slow);
      } catch (e) {
        clearTimeout(slow);
        console.warn('Eigene Stimme', e);
        if (gen !== piperGen) return;
        toast('Die eigene Stimme konnte nicht sprechen – es liest die Gerätestimme vor', 4000);
        settings.ttsVoice = '';
        saveSettings(settings);
        voiceLabel();
        if (active) speakFrom(cur);
        return;
      }
      if (gen !== piperGen || !active) return;
      // nächstes Stück schon vorbereiten, damit keine Pause entsteht
      const pn = pieceAt(next);
      if (pn) {
        piperAudio(pn.piece).catch(() => {});
        const pn2 = pieceAt(pn.next);
        if (pn2) piperAudio(pn2.piece).catch(() => {});
      }
      const m = await piper();
      piperPlay = m.play(audio);
      const h0 = piperPlay;
      // Wortgrenzen: gleichmäßig über die Dauer verteilt (die Stimme liefert keine Zeitmarken)
      const words = [...piece.matchAll(/\S+/g)].map((x) => x.index);
      const ac = m.audioContext();
      piperTick = setInterval(() => {
        if (gen !== piperGen) return;
        const t = Math.min(1, (ac.currentTime - h0.started) / Math.max(0.1, h0.duration));
        const ci = Math.floor(t * piece.length);
        let w = 0;
        for (const x of words) { if (x <= ci) w = x; else break; }
        onWord(w);
      }, 250);
      const ended = await h0.done;
      clearInterval(piperTick);
      if (!ended || gen !== piperGen || !active) return;
      piperPlay = null;
      speakFrom(next);
    }
    function play() {
      if (!synth && !engineIsPiper()) { toast('Vorlesen wird von diesem Browser nicht unterstützt'); return; }
      if (engineIsPiper()) { piperFirst = true; unlockAudio(); } // muss in der Tipp-Geste passieren (iOS)
      if (settings.mode !== 'text') { switchModeTo('text', pos?.pageIndex ?? 0); }
      active = true;
      bar.hidden = false;
      voiceLabel();
      playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', 'Pause');
      speakFrom(cur || locate(screen));
    }
    function pause() {
      active = false;
      if (utter) utter.__cancelled = true;
      stopPiper();
      if (synth) synth.cancel();
      playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', 'Weiter vorlesen');
    }
    function stop() {
      pause();
      cur = null;
      bar.hidden = true;
      if (sleep) setSleep(null);
      content.querySelectorAll('.speaking').forEach((e) => e.classList.remove('speaking'));
    }
    return {
      toggle() { if (active) pause(); else { cur = null; play(); } },
      stop,
      isActive: () => active,
    };
  })();

  // ---------- Lesestatistik (Lesezeit je Tag) ----------
  let lastActivity = Date.now();
  function recordActivity() { lastActivity = Date.now(); }
  const statTick = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastActivity > 120000 && !tts.isActive()) return; // länger nichts gemacht → nicht zählen
    import('./stats.js').then(async (m) => {
      await m.addReading(profileId, bookId, 15);
      // Tagesziel erreicht? (einmal pro Tag melden)
      const goal = profiles.current() && profiles.current().goalMin;
      if (!goal) return;
      const day = m.dayKey();
      const sec = ((await m.getStats(profileId)).days[day] || {}).sec || 0;
      let told = '';
      try { told = localStorage.getItem('ob.goalTold.' + profileId) || ''; } catch (e) { /* */ }
      if (sec >= goal * 60 && told !== day) {
        try { localStorage.setItem('ob.goalTold.' + profileId, day); } catch (e) { /* */ }
        toast(`Tagesziel erreicht: ${goal} Min. gelesen`, 3500);
      }
    }).catch(() => {});
  }, 15000);

  // ---------- Fußnoten ----------
  function openFootnote(label, fromFi) {
    // die nächste Fußnote mit dieser Nummer nach dem Verweis, sonst die davor
    let target = -1;
    for (let i = fromFi; i < flow.length; i++) if (flow[i].block === 'fn' && flow[i].label === label) { target = i; break; }
    if (target < 0) for (let i = fromFi; i >= 0; i--) if (flow[i].block === 'fn' && flow[i].label === label) { target = i; break; }
    if (target < 0) { toast(`Fußnote ${label} nicht gefunden`); return; }
    const f = flow[target];
    const body = h('p', { class: 'fn-pop' });
    body.append(renderInline(f.md));
    const s = sheet('Fußnote ' + label, h('div', { class: 'stack' }, body,
      h('button', { class: 'btn small', onClick: () => { s.close(); userNav(); goToFlow(target, 0); afterMove(); } }, 'Zur Fußnote im Text springen')));
  }

  // ---------- Abbildung vergrößert ansehen ----------
  function openFigure(id) {
    const fig = [...figMap.values()].flat().find((f) => f.id === id);
    if (!fig) return;
    const item = flow.find((f) => f.figure && f.figure.id === id);
    const caption = (item && item.caption) || fig.caption || '';
    const url = URL.createObjectURL(fig.image);
    const img = h('img', { src: url, alt: caption || 'Abbildung', draggable: 'false' });
    const stage = h('div', { class: 'fv-stage' }, img);
    let zm = null;
    const close = () => { ov.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onEsc, true); zm && zm.destroy(); };
    const onEsc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    const zoomBtn = iconButton('zoom', 'Vergrößern', () => zm && zm.toggle());
    const ov = h('div', { class: 'figviewer', role: 'dialog', 'aria-label': 'Abbildung' },
      h('div', { class: 'fv-bar' }, iconButton('close', 'Schließen', close), h('div', { class: 'grow fv-cap' }, caption), zoomBtn),
      stage,
      h('p', { class: 'fv-hint' }, 'Mit zwei Fingern zoomen, doppelt tippen zum Vergrößern'),
    );
    document.addEventListener('keydown', onEsc, true);
    document.body.append(ov);
    import('./zoom.js').then(({ zoomable }) => { zm = zoomable(stage, img); });
  }

  // ---------- Menü ----------
  function openMenu() { menuOpen = true; view.classList.add('menu-open'); }
  function closeMenu() { menuOpen = false; view.classList.remove('menu-open'); }

  let sliderDragging = false;
  slider.addEventListener('input', () => {
    sliderDragging = true;
    const r = slider.value / 1000;
    if (settings.mode === 'images') {
      sliderLabel.textContent = `${pageLabel(Math.round(r * (pages.length - 1)))} von ${pageTotal()}`;
    } else {
      const fi = flowIndexAtGlobal(r * totalChars);
      sliderLabel.textContent = `${pageLabel(sourcePageAt(fi, 0))} von ${pageTotal()} · ${Math.round(r * 100)} %`;
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
    const fnBtn = e.target.closest && e.target.closest('.fnref');
    if (fnBtn && Math.abs(dx) < 10 && Math.abs(dy) < 10) { openFootnote(fnBtn.dataset.fn, +fnBtn.closest('[data-fi]').dataset.fi); return; }
    const showBtn = e.target.closest && e.target.closest('[data-show-page]');
    if (showBtn) { switchModeTo('images', +showBtn.dataset.showPage); return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && content.contains(sel.anchorNode)) {
      // Text ist markiert: Antippen hebt die Auswahl auf statt zu blättern
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 600 && !(e.target.closest && e.target.closest('.hl-bar'))) { sel.removeAllRanges(); hideHlBar(); }
      return;
    }
    const markEl = e.target.closest && e.target.closest('mark.hl');
    if (markEl && !menuOpen && Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 600) { openHighlight(markEl.dataset.hl); return; }
    const figEl = e.target.closest && e.target.closest('figure.fig');
    if (figEl && !menuOpen && Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 600) { openFigure(figEl.dataset.fig); return; }
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
      const newPages = await db.getPagesMeta(bookId, { images: false });
      book = (await db.getBook(bookId)) || book;
      if (!newPages.length) return;
      const figCount = [...figMap.values()].flat().length;
      await loadFigures();
      const figChanged = e.type === 'figure' || [...figMap.values()].flat().length !== figCount;
      const textChanged = figChanged || newPages.length !== pages.length || newPages.some((p, i) => p.id !== pages[i].id || p.text !== pages[i].text || p.printedNo !== pages[i].printedNo);
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
      h('span', {}, `Auf einem anderen Gerät bis ${pageLabel(rp.pageIndex ?? 0)} (${Math.round((rp.ratio || 0) * 100)} %) gelesen.`),
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
  await loadFigures();
  rebuildFlow();
  restore();
  // Sprung aus der Suche über alle Bücher
  const jump = takeJump(bookId);
  if (jump && settings.mode === 'text') {
    let fi = flow.findIndex((f) => f.pageId === jump.pageId && f.p === jump.p);
    let char = jump.char;
    if (fi < 0) {
      fi = flow.findIndex((f) => f.continues && f.continues.some((c) => c.pageId === jump.pageId));
      if (fi >= 0) char += flow[fi].continues.find((c) => c.pageId === jump.pageId).offset;
    }
    if (fi >= 0) { userNav(); goToFlow(fi, char); }
  } else if (jump) {
    const pi = pages.findIndex((p) => p.id === jump.pageId);
    if (pi >= 0) { userNav(); renderImage(pi); }
  }
  try {
    if (!localStorage.getItem('ob.hint')) {
      localStorage.setItem('ob.hint', '1');
      setTimeout(() => toast('Tippe rechts zum Weiterblättern, in die Mitte für das Menü', 4000), 400);
    }
  } catch (e) { /* ignorieren */ }

  return () => {
    clearTimeout(saveTimer);
    if (pos && userMoved) db.updateState(profileId, bookId, { position: pos, lastOpenedAt: Date.now() });
    tts.stop();
    clearInterval(statTick);
    document.removeEventListener('selectionchange', onSel);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    clearTimeout(refreshTimer);
    off();
    if (wakeLock) wakeLock.release().catch(() => {});
    pool.clear();
    figPool.clear();
  };
}
