import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, sheet, confirmDialog, pickFiles, UrlPool, coverColor, download, safeName } from './ui.js';
import { processCapture, processCover } from './imageproc.js';
import { openScanner } from './scanner.js';
import { openReader } from './reader.js';
import { openPageEditor } from './pageeditor.js';
import { openSend, openReceive } from './transferview.js';
import * as profiles from './profiles.js';
import * as sync from './sync/sync.js';
import { clientId, redirectUri } from './sync/oauth.js';
import { checkPages, describe } from './pagecheck.js';

const app = document.getElementById('app');
let cleanup = null;

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, () => renderLibrary()],
  [/^#\/book\/([\w]+)$/, (m) => renderBook(m[1])],
  [/^#\/scan\/([\w]+)$/, (m) => openScanner(app, m[1])],
  [/^#\/scan\/([\w]+)\/nach\/([\w]+)(?:\/(\d+))?$/, (m) => openScanner(app, m[1], m[2], +(m[3] || 1))],
  [/^#\/read\/([\w]+)$/, (m) => openReader(app, m[1])],
  [/^#\/send\/([\w]+)$/, (m) => openSend(app, m[1])],
  [/^#\/receive$/, () => openReceive(app)],
  [/^#\/page\/([\w]+)\/([\w]+)$/, (m) => openPageEditor(app, m[1], m[2])],
];

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  app.replaceChildren();
  document.body.className = '';
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        cleanup = (await fn(m)) || null;
      } catch (e) {
        console.error(e);
        app.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Etwas ist schiefgelaufen: ' + e.message), h('a', { class: 'btn', href: '#/' }, 'Zur Bibliothek')));
      }
      return;
    }
  }
  location.hash = '#/';
}

export function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

window.addEventListener('hashchange', route);

// ---------- OCR-Statusanzeige ----------

function ocrBadge() {
  const el = h('div', { class: 'ocr-badge', hidden: true });
  const off = ocr.onStatus((s) => {
    el.hidden = s.total === 0;
    el.replaceChildren(h('span', { class: 'spinner' }), `Texterkennung: noch ${s.total} ${s.total === 1 ? 'Seite' : 'Seiten'}`);
  });
  el._off = off;
  return el;
}

// ---------- Bibliothek ----------

async function renderLibrary() {
  const pool = new UrlPool();
  const badge = ocrBadge();
  const grid = h('div', { class: 'grid' });
  let sortMode = localStorage.getItem('ob.sort') || 'recent';

  const sortSel = h('select', { class: 'select', 'aria-label': 'Sortierung', onChange: (e) => { sortMode = e.target.value; localStorage.setItem('ob.sort', sortMode); fill(); } },
    h('option', { value: 'recent' }, 'Zuletzt gelesen'),
    h('option', { value: 'title' }, 'Titel'),
    h('option', { value: 'author' }, 'Autor'),
    h('option', { value: 'added' }, 'Hinzugefügt'),
  );
  sortSel.value = sortMode;
  const avatarBtn = h('button', { class: 'avatar-btn', 'aria-label': 'Profil wechseln', onClick: () => openProfiles() });
  const libTitle = h('h2', {});
  const syncIndicator = syncIndicatorEl();
  function showProfile() {
    const p = profiles.current();
    avatarBtn.replaceChildren(avatar(p));
    avatarBtn.title = 'Profil: ' + (p ? p.name : '');
    libTitle.textContent = p && multiProfile ? `Bibliothek · ${p.name.split(/\s+/)[0]}` : 'Bibliothek';
  }
  let multiProfile = (await db.getProfiles()).length > 1;
  showProfile();

  const view = h('div', { class: 'page library' },
    h('header', { class: 'topbar' },
      h('h1', { class: 'brand' }, icon('book'), 'openBook'),
      h('div', { class: 'row gap-s' },
        syncIndicator,
        iconButton('settings', 'Einstellungen & Sicherung', () => openSettings()),
        avatarBtn,
        h('button', { class: 'btn primary btn-add', 'aria-label': 'Neues Buch', onClick: () => newBookDialog() }, icon('plus'), h('span', { class: 'label' }, 'Buch')),
      ),
    ),
    h('div', { class: 'toolbar' }, libTitle, sortSel),
    badge,
    grid,
  );
  app.append(view);

  async function fill() {
    pool.clear();
    const books = await db.getBooks();
    const states = new Map((await db.getStatesOfProfile(profiles.currentId())).map((st) => [st.bookId, st]));
    for (const b of books) b._state = states.get(b.id) || null;
    const opened = (b) => (b._state && b._state.lastOpenedAt) || b.createdAt;
    const sorters = {
      recent: (a, b) => opened(b) - opened(a),
      title: (a, b) => a.title.localeCompare(b.title, 'de'),
      author: (a, b) => (a.author || '').localeCompare(b.author || '', 'de') || a.title.localeCompare(b.title, 'de'),
      added: (a, b) => b.createdAt - a.createdAt,
    };
    books.sort(sorters[sortMode] || sorters.recent);
    if (!books.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        icon('book', 'big'),
        h('h3', {}, 'Noch keine Bücher'),
        h('p', { class: 'muted' }, 'Lege ein Buch an und fotografiere die Seiten. openBook erkennt den Text und du kannst das Buch danach überall lesen, auch ohne Internet.'),
        h('button', { class: 'btn primary', onClick: () => newBookDialog() }, icon('plus'), 'Erstes Buch anlegen'),
      ));
      return;
    }
    grid.replaceChildren(...books.map((b) => bookTile(b, pool)));
  }

  await fill();
  let t = null;
  const off = db.onChange((e) => {
    if (!['book', 'pages', 'sync', 'profile'].includes(e.type)) return;
    clearTimeout(t);
    t = setTimeout(async () => { multiProfile = (await db.getProfiles()).length > 1; showProfile(); fill(); }, 100);
  });
  const offSwitch = profiles.onSwitch(() => { showProfile(); fill(); });
  return () => { off(); offSwitch(); badge._off(); syncIndicator._off(); pool.clear(); clearTimeout(t); };
}

export function coverEl(book, pool, cls = '') {
  if (book.cover) {
    return h('div', { class: 'cover ' + cls }, h('img', { src: pool.get(book.cover), alt: '', loading: 'lazy' }));
  }
  const [bg, fg] = coverColor(book.title);
  return h('div', { class: 'cover generated ' + cls, style: { background: bg, color: fg } },
    h('div', { class: 'cover-title' }, book.title),
    book.author ? h('div', { class: 'cover-author' }, book.author) : null,
  );
}

function progressOf(book) {
  const pos = book._state && book._state.position;
  if (!book.pageOrder.length || !pos) return 0;
  return Math.max(0, Math.min(1, pos.ratio || 0));
}

export function avatar(p, cls = '') {
  return h('span', { class: 'avatar ' + cls, style: { background: (p && p.color) || '#888' } }, profiles.initials(p ? p.name : '?'));
}

// Kleines Wolken-Symbol mit Sync-Status (nur sichtbar, wenn Sync eingerichtet ist)
function syncIndicatorEl() {
  const btn = h('button', { class: 'icon-btn sync-ind', 'aria-label': 'Synchronisierung', onClick: () => {
    const st = sync.getStatus();
    if (st.state === 'auth' && sync.getProvider()) sync.getProvider().connect({ silent: false });
    else if (st.state === 'error' || st.state === 'offline') { toast(st.message || 'Sync-Fehler'); sync.syncNow({ interactive: true }); }
    else { sync.syncNow({ interactive: true }); toast('Wird synchronisiert …'); }
  } }, icon('cloud'));
  btn._off = sync.onStatus((st) => {
    btn.hidden = st.state === 'off';
    btn.dataset.state = st.state;
    btn.title = {
      idle: 'Synchronisiert' + (st.lastSync ? ' · ' + timeAgo(st.lastSync) : ''),
      syncing: 'Wird synchronisiert …',
      error: 'Sync-Fehler: ' + st.message,
      auth: 'Bitte erneut anmelden (antippen)',
      offline: 'Offline',
    }[st.state] || '';
    btn.setAttribute('aria-label', btn.title);
  });
  return btn;
}

function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'gerade eben';
  if (d < 3600) return `vor ${Math.round(d / 60)} Min.`;
  if (d < 86400) return `vor ${Math.round(d / 3600)} Std.`;
  return new Date(t).toLocaleDateString('de-DE');
}

function bookTile(book, pool) {
  const pct = Math.round(progressOf(book) * 100);
  const n = book.pageOrder.length;
  return h('div', { class: 'tile' },
    h('button', {
      class: 'tile-main',
      'aria-label': `${book.title} öffnen`,
      onClick: () => go(n ? `#/read/${book.id}` : `#/book/${book.id}`),
    },
      coverEl(book, pool),
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
    ),
    h('div', { class: 'tile-info' },
      h('div', { class: 'tile-text' },
        h('div', { class: 'tile-title' }, book.title),
        h('div', { class: 'tile-meta' }, n ? `${pct} % · ${n} S.` : 'Noch keine Seiten'),
      ),
      iconButton('more', 'Buchdetails', () => go(`#/book/${book.id}`), 'small'),
    ),
  );
}

// ---------- Neues Buch ----------

function newBookDialog() {
  let coverBlob = null;
  const pool = new UrlPool();
  const title = h('input', { class: 'input', placeholder: 'Titel', required: true, autocomplete: 'off' });
  const author = h('input', { class: 'input', placeholder: 'Autor:in (optional)', autocomplete: 'off' });
  const preview = h('div', { class: 'cover-pick' }, icon('camera'), h('span', {}, 'Cover fotografieren (optional)'));
  const pickCover = async () => {
    const [f] = await pickFiles({ multiple: false, capture: 'environment' });
    if (!f) return;
    coverBlob = await processCover(f);
    preview.replaceChildren(h('img', { src: pool.get(coverBlob), alt: 'Cover' }));
  };
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (!title.value.trim()) { title.focus(); return; }
    const book = await db.createBook({ title: title.value.trim(), author: author.value.trim(), cover: coverBlob });
    db.requestPersistence();
    s.close();
    go(`#/scan/${book.id}`);
  } },
    h('button', { type: 'button', class: 'cover-pick-btn', onClick: pickCover }, preview),
    title, author,
    h('button', { class: 'btn primary block', type: 'submit' }, icon('camera'), 'Anlegen & Seiten scannen'),
  );
  const s = sheet('Neues Buch', form, { onClose: () => pool.clear() });
  setTimeout(() => title.focus(), 250);
}

// ---------- Buchdetails ----------

async function renderBook(bookId) {
  const pool = new UrlPool();
  let book = await db.getBook(bookId);
  if (!book) { go('#/'); return; }
  const badge = ocrBadge();
  const head = h('div', { class: 'book-head' });
  const pagesGrid = h('div', { class: 'pages-grid' });
  const issuesCard = h('div', { class: 'card issues', hidden: true });

  const view = h('div', { class: 'page book' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => go('#/')),
      h('div', { class: 'grow' }),
      iconButton('more', 'Weitere Aktionen', () => bookActions()),
    ),
    head,
    badge,
    h('div', { class: 'toolbar' }, h('h2', {}, 'Seiten'),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'btn small', onClick: () => importImages() }, icon('images'), 'Fotos importieren'),
      ),
    ),
    issuesCard,
    pagesGrid,
  );
  app.append(view);

  async function importImages() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.lastModified - b.lastModified);
    const split = await confirmDialog('Doppelseiten?', 'Zeigen die Fotos jeweils zwei Buchseiten nebeneinander? Dann teilt openBook jedes Foto in eine linke und rechte Seite.', 'Ja, teilen');
    const scanFilter = localStorage.getItem('ob.scanFilter') !== '0';
    toast(`${files.length} Fotos werden verarbeitet …`);
    let n = 0;
    for (const f of files) {
      const parts = await processCapture(f, { split, scanFilter });
      for (const part of parts) {
        const page = await db.addPage(bookId, part);
        ocr.enqueue(page.id);
        n++;
      }
    }
    toast(`${n} Seiten hinzugefügt`);
  }

  async function fillHead() {
    book = await db.getBook(bookId);
    if (!book) { go('#/'); return; }
    const pages = await db.getPagesMeta(bookId);
    const state = await db.getState(profiles.currentId(), bookId);
    const done = pages.filter((p) => p.ocrStatus === 'done').length;
    const errs = pages.filter((p) => p.ocrStatus === 'error').length;
    const words = pages.reduce((s, p) => s + (p.text ? p.text.split(/\s+/).length : 0), 0);
    head.replaceChildren(
      coverEl(book, pool, 'large'),
      h('div', { class: 'book-meta' },
        h('h1', {}, book.title),
        book.author ? h('p', { class: 'author' }, book.author) : null,
        h('p', { class: 'muted small' },
          `${pages.length} Seiten · ${done} erkannt` + (errs ? ` · ${errs} Fehler` : '') + (words ? ` · ca. ${Math.max(1, Math.round(words / 250))} Min. Lesezeit` : ''),
        ),
        h('div', { class: 'row gap-s wrap' },
          pages.length ? h('button', { class: 'btn primary', onClick: () => go(`#/read/${bookId}`) }, icon('book'), state && state.position ? 'Weiterlesen' : 'Lesen') : null,
          h('button', { class: 'btn', onClick: () => go(`#/scan/${bookId}`) }, icon('camera'), 'Seiten scannen'),
        ),
      ),
    );
    const figs = await db.getFiguresOfBook(bookId);
    figPages = new Set(figs.map((f) => f.pageId));
    renderIssues(pages);
    pagesGrid.replaceChildren(...(pages.length ? pages.map((p, i) => pageTile(p, i)) : [
      h('p', { class: 'muted pad' }, 'Noch keine Seiten. Tippe auf „Seiten scannen“.'),
    ]));
  }

  let figPages = new Set();

  // Seitenprüfung: fehlende, doppelte, vertauschte Seiten anhand der gedruckten Seitenzahlen
  function renderIssues(pages) {
    const all = checkPages(pages, { ignored: book.ignoredGaps || [] });
    const withNo = pages.filter((p) => p.printedNo).length;
    if (!all.length) {
      issuesCard.hidden = !withNo || pages.length < 3;
      issuesCard.className = 'card issues ok';
      issuesCard.replaceChildren(h('span', { class: 'row gap-s' }, icon('check'), `Seitenprüfung: keine Lücken gefunden (${withNo} von ${pages.length} Seitenzahlen erkannt).`));
      return;
    }
    issuesCard.hidden = false;
    issuesCard.className = 'card issues';
    const ignore = async (key) => { await db.updateBook(bookId, (b) => ({ ignoredGaps: [...new Set([...(b.ignoredGaps || []), key])] })); };
    issuesCard.replaceChildren(
      h('strong', {}, all.length === 1 ? 'Seitenprüfung: 1 Hinweis' : `Seitenprüfung: ${all.length} Hinweise`),
      ...all.map((is) => h('div', { class: 'issue' },
        h('span', { class: 'grow' }, describe(is)),
        h('div', { class: 'row gap-s wrap' },
          is.type === 'missing'
            ? h('button', { class: 'btn small primary', onClick: () => go(`#/scan/${bookId}/nach/${is.afterPageId}/${Math.min(is.count, 20)}`) }, icon('camera'), 'Nachscannen')
            : h('button', { class: 'btn small', onClick: () => go(`#/page/${bookId}/${is.pageId || is.pageIds[1]}`) }, 'Ansehen'),
          h('button', { class: 'btn small', onClick: () => ignore(is.key) }, 'Passt so'),
        ),
      )),
    );
  }

  function pageTile(p, i) {
    const label = { pending: 'wartet', running: 'erkennt …', done: '', error: 'Fehler', remote: 'anderes Gerät' }[p.ocrStatus] || '';
    return h('button', { class: 'page-tile', onClick: () => go(`#/page/${bookId}/${p.id}`), 'aria-label': `Seite ${i + 1} bearbeiten` },
      p.thumb
        ? h('img', { src: pool.get(p.thumb), alt: '', loading: 'lazy' })
        : h('span', { class: 'page-textthumb' }, (p.text || '').slice(0, 220)),
      h('span', { class: 'page-no' }, p.printedNo ? `S. ${p.printedNo}` : i + 1),
      label ? h('span', { class: 'page-status ' + p.ocrStatus }, label) : null,
      figPages.has(p.id) ? h('span', { class: 'page-fig', title: 'Enthält Abbildung' }, icon('figure')) : null,
    );
  }

  function bookActions() {
    const s = sheet('Buch', h('div', { class: 'menu' },
      h('button', { class: 'menu-item', onClick: () => { s.close(); editMeta(); } }, icon('edit'), 'Titel, Autor & Cover bearbeiten'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const { exportEpub } = await import('./epub.js');
        toast('EPUB wird erstellt …');
        const blob = await exportEpub(bookId);
        download(blob, safeName(book.title) + '.epub');
      } }, icon('download'), 'Als EPUB exportieren (z. B. für Kindle)'),
      h('button', { class: 'menu-item', onClick: () => { s.close(); go(`#/send/${bookId}`); } }, icon('wifi'), 'An eigenes Gerät senden (WLAN, ohne Internet)'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const { exportBackup } = await import('./backup.js');
        toast('Sicherung wird erstellt …');
        const blob = await exportBackup([bookId]);
        download(blob, safeName(book.title) + '.openbook.zip');
      } }, icon('download'), 'Buch sichern (mit Fotos)'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const pages = await db.getPagesMeta(bookId);
        const withImg = pages.filter((p) => p.image);
        if (!withImg.length) { toast('Auf diesem Gerät gibt es keine Seitenfotos zum Erkennen'); return; }
        const failed = withImg.filter((p) => p.ocrStatus !== 'done');
        const ok = await confirmDialog('Text neu erkennen', failed.length
          ? `Nur die ${failed.length} nicht erkannten Seiten erneut erkennen?`
          : 'Alle Seiten erneut erkennen? Manuelle Textkorrekturen gehen dabei verloren.', 'Starten');
        if (!ok) return;
        const list = failed.length ? failed : withImg;
        for (const p of list) { await db.updatePage(p.id, { ocrStatus: 'pending' }); ocr.enqueue(p.id); }
      } }, icon('refresh'), 'Text neu erkennen'),
      h('button', { class: 'menu-item danger', onClick: async () => {
        s.close();
        if (await confirmDialog('Buch löschen?', `„${book.title}“ mit allen Seiten wird von diesem Gerät gelöscht.`, 'Löschen', true)) {
          await db.deleteBook(bookId);
          toast('Buch gelöscht');
          go('#/');
        }
      } }, icon('trash'), 'Buch löschen'),
    ));
  }

  function editMeta() {
    let cover = book.cover;
    const p2 = new UrlPool();
    const title = h('input', { class: 'input', value: book.title });
    const author = h('input', { class: 'input', value: book.author || '', placeholder: 'Autor:in' });
    const prev = h('div', { class: 'cover-pick' });
    const showPrev = () => prev.replaceChildren(cover ? h('img', { src: p2.get(cover), alt: '' }) : h('span', {}, icon('camera'), ' Cover fotografieren'));
    showPrev();
    const s = sheet('Buch bearbeiten', h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      await db.updateBook(bookId, { title: title.value.trim() || book.title, author: author.value.trim(), cover });
      s.close();
    } },
      h('button', { type: 'button', class: 'cover-pick-btn', onClick: async () => {
        const [f] = await pickFiles({ multiple: false, capture: 'environment' });
        if (f) { cover = await processCover(f); showPrev(); }
      } }, prev),
      h('div', { class: 'row gap-s' },
        h('button', { type: 'button', class: 'btn small', onClick: async () => {
          const pages = await db.getPagesMeta(bookId);
          const first = pages.find((p) => p.image);
          if (first) { cover = await processCover(first.image); showPrev(); }
          else toast('Auf diesem Gerät gibt es keine Seitenfotos');
        } }, 'Erste Seite als Cover'),
        cover ? h('button', { type: 'button', class: 'btn small', onClick: () => { cover = null; showPrev(); } }, 'Cover entfernen') : null,
      ),
      title, author,
      h('button', { class: 'btn primary block', type: 'submit' }, 'Speichern'),
    ), { onClose: () => p2.clear() });
  }

  await fillHead();
  let t = null;
  const off = db.onChange((e) => {
    if (e.type !== 'sync' && e.bookId !== bookId) return;
    clearTimeout(t);
    t = setTimeout(() => { pool.clear(); fillHead(); }, 150);
  });
  return () => { off(); badge._off(); pool.clear(); clearTimeout(t); };
}

// ---------- Einstellungen & Sicherung ----------

async function openSettings() {
  const est = await db.storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const fmt = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');
  const scanFilter = h('input', { type: 'checkbox', checked: localStorage.getItem('ob.scanFilter') !== '0',
    onChange: (e) => localStorage.setItem('ob.scanFilter', e.target.checked ? '1' : '0') });

  const syncEl = syncCard();
  const s = sheet('Einstellungen', h('div', { class: 'stack' },
    syncEl,
    h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Scan-Filter'), h('br'), h('span', { class: 'muted small' }, 'Fotos in Graustufen mit hellem Papier speichern. Bessere Erkennung, weniger Speicher.')), scanFilter),
    h('div', { class: 'card' },
      h('strong', {}, 'Speicher'),
      h('p', { class: 'muted small' },
        est ? `Belegt: ${fmt(est.usage || 0)} von ca. ${fmt(est.quota || 0)}. ` : '',
        persisted ? 'Dauerhafter Speicher ist aktiv.' : 'Der Browser darf Daten bei Platzmangel löschen. Mach regelmäßig eine Sicherung.',
      ),
      !persisted ? h('button', { class: 'btn small', onClick: async () => {
        const ok = await db.requestPersistence();
        toast(ok ? 'Dauerhafter Speicher aktiviert' : 'Der Browser hat das abgelehnt. Installiere openBook auf dem Startbildschirm.');
      } }, 'Dauerhaften Speicher anfordern') : null,
    ),
    h('div', { class: 'card' },
      h('strong', {}, 'Buch empfangen'),
      h('p', { class: 'muted small' }, 'Ein Buch direkt von einem anderen eigenen Gerät übernehmen – per WLAN oder Hotspot, ohne Internet.'),
      h('button', { class: 'btn small', onClick: () => { s.close(); go('#/receive'); } }, icon('wifi'), 'Buch empfangen'),
    ),
    h('div', { class: 'card' },
      h('strong', {}, 'Sicherung'),
      h('p', { class: 'muted small' }, 'Alle Bücher inklusive Fotos als Datei speichern, z. B. für ein neues Handy oder als Backup in der Cloud.'),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn small', onClick: async () => {
          const { exportBackup } = await import('./backup.js');
          toast('Sicherung wird erstellt …');
          const blob = await exportBackup();
          download(blob, `openbook-sicherung-${new Date().toISOString().slice(0, 10)}.openbook.zip`);
        } }, icon('download'), 'Alles sichern'),
        h('button', { class: 'btn small', onClick: async () => {
          const [f] = await pickFiles({ accept: '.zip,.openbook,application/zip', multiple: false });
          if (!f) return;
          const { importBackup } = await import('./backup.js');
          try {
            const n = await importBackup(f);
            toast(`${n} ${n === 1 ? 'Buch' : 'Bücher'} wiederhergestellt`);
            s.close();
            ocr.resume();
          } catch (e) {
            console.error(e);
            toast('Import fehlgeschlagen: ' + e.message);
          }
        } }, icon('upload'), 'Sicherung laden'),
      ),
    ),
    h('p', { class: 'muted small' }, 'Die Texterkennung läuft lokal, Fotos werden nie hochgeladen. Ohne Synchronisierung bleibt alles nur auf diesem Gerät. Nur für Bücher, die dir selbst gehören.'),
  ), { onClose: () => syncEl._off() });
}

// ---------- Start ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

(async () => {
  try {
    await profiles.ensureProfile();
    await sync.init(); // verarbeitet ggf. die Rückkehr von der Anmeldeseite
  } catch (e) {
    console.error(e);
  }
  route();
  ocr.resume();
})();

// ---------- Leseprofile ----------

async function openProfiles() {
  const list = h('div', { class: 'menu' });
  async function fillList() {
    const all = (await db.getProfiles()).sort((a, b) => a.createdAt - b.createdAt);
    const cur = profiles.currentId();
    list.replaceChildren(...all.map((p) => h('div', { class: 'profile-row' + (p.id === cur ? ' current' : '') },
      h('button', { class: 'profile-pick', onClick: async () => {
        await profiles.switchTo(p.id);
        s.close();
        toast(`Profil „${p.name}“`);
      } }, avatar(p, 'big'), h('span', { class: 'grow' }, h('strong', {}, p.name), p.id === cur ? h('span', { class: 'muted small' }, ' · aktiv') : null)),
      iconButton('edit', `${p.name} bearbeiten`, () => editProfile(p, all.length), 'small'),
    )));
  }
  const s = sheet('Wer liest?', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Jedes Profil hat eigene Lesepositionen, Lesezeichen und Schrifteinstellungen. Die Bücher teilen sich alle Profile.'),
    list,
    h('button', { class: 'btn block', onClick: () => editProfile(null, 0) }, icon('plus'), 'Profil hinzufügen'),
  ));
  await fillList();

  async function editProfile(p, count) {
    const used = new Set((await db.getProfiles()).map((x) => x.color));
    let color = p ? p.color : (db.PROFILE_COLORS.find((c) => !used.has(c)) || db.PROFILE_COLORS[0]);
    const name = h('input', { class: 'input', value: p ? p.name : '', placeholder: 'Name', maxlength: 30 });
    const colors = h('div', { class: 'color-row' });
    const paint = () => colors.replaceChildren(...db.PROFILE_COLORS.map((c) => h('button', {
      type: 'button', class: 'color-dot' + (c === color ? ' on' : ''), style: { background: c }, 'aria-label': 'Farbe ' + c,
      onClick: () => { color = c; paint(); },
    })));
    paint();
    const e = sheet(p ? 'Profil bearbeiten' : 'Neues Profil', h('form', { class: 'stack', onSubmit: async (ev) => {
      ev.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      if (p) {
        const cur = await db.getProfile(p.id);
        await db.putProfile({ ...cur, name: n, color });
      } else {
        const np = await db.createProfile(n, color);
        await profiles.switchTo(np.id);
      }
      e.close();
      await fillList();
    } },
      name, colors,
      h('button', { class: 'btn primary block', type: 'submit' }, 'Speichern'),
      p && count > 1 ? h('button', { type: 'button', class: 'btn danger block', onClick: async () => {
        if (!(await confirmDialog('Profil löschen?', `Lesepositionen und Lesezeichen von „${p.name}“ werden gelöscht – auf allen synchronisierten Geräten. Die Bücher bleiben erhalten.`, 'Löschen', true))) return;
        await db.deleteProfile(p.id);
        if (profiles.currentId() === p.id) await profiles.ensureProfile().then((np) => profiles.switchTo(np.id));
        e.close();
        await fillList();
      } }, icon('trash'), 'Profil löschen') : null,
    ));
    setTimeout(() => name.focus(), 250);
  }
}

// ---------- Synchronisierung (Einstellungen) ----------

function syncCard() {
  const card = h('div', { class: 'card' });
  card._off = sync.onStatus(render);
  function render(st) {
    const prov = sync.getProvider();
    card.replaceChildren(h('strong', {}, 'Synchronisierung'));
    if (!prov) {
      card.append(
        h('p', { class: 'muted small' }, 'Texte, Lesepositionen, Lesezeichen und Profile auf all deinen Geräten abgleichen – über deinen eigenen Cloud-Speicher. Fotos bleiben auf dem Gerät.'),
        h('div', { class: 'row gap-s wrap' },
          ...Object.values(sync.PROVIDERS).map((p) => h('button', {
            class: 'btn small',
            disabled: !p.isConfigured(),
            onClick: () => sync.connect(p.id),
          }, icon('cloud'), p.label + ' verbinden')),
        ),
      );
      if (!Object.values(sync.PROVIDERS).some((p) => p.isConfigured())) {
        card.append(h('p', { class: 'muted small' }, 'Noch nicht eingerichtet: Es fehlt eine Client-ID (siehe Anleitung SYNC.md oder „Erweitert“).'));
      }
    } else {
      const lines = {
        idle: st.lastSync ? `Zuletzt synchronisiert ${timeAgo(st.lastSync)}` : 'Verbunden',
        syncing: 'Wird synchronisiert …',
        error: 'Fehler: ' + st.message,
        auth: 'Anmeldung abgelaufen – bitte neu anmelden.',
        offline: 'Offline – wird nachgeholt, sobald Internet da ist.',
      };
      card.append(
        h('p', { class: 'small' }, `${prov.label}${prov.account() ? ' · ' + prov.account() : ''}`),
        h('p', { class: 'muted small' }, lines[st.state] || ''),
        h('div', { class: 'row gap-s wrap' },
          st.state === 'auth'
            ? h('button', { class: 'btn small primary', onClick: () => prov.connect({ silent: false }) }, 'Neu anmelden')
            : h('button', { class: 'btn small', disabled: st.state === 'syncing', onClick: () => sync.syncNow({ interactive: true }) }, icon('refresh'), 'Jetzt synchronisieren'),
          h('button', { class: 'btn small', onClick: async () => {
            if (await confirmDialog('Synchronisierung trennen?', 'Die Bücher bleiben auf diesem Gerät. Die Daten in der Cloud werden nicht gelöscht.', 'Trennen')) sync.disconnect();
          } }, 'Trennen'),
        ),
      );
    }
    card.append(h('details', { class: 'advanced' },
      h('summary', { class: 'small muted' }, 'Erweitert: eigene Client-IDs'),
      h('p', { class: 'muted small' }, 'Weiterleitungs-Adresse für die Einrichtung: ', h('code', {}, redirectUri())),
      ...[['google', 'Google Client-ID'], ['microsoft', 'Microsoft Client-ID']].map(([k, label]) => {
        let stored = '';
        try { stored = localStorage.getItem('ob.cfg.' + k) || ''; } catch (e) { /* ignorieren */ }
        return h('label', { class: 'stack-s small' }, label,
          h('input', { class: 'input', value: stored, placeholder: clientId(k) || 'nicht gesetzt', autocomplete: 'off', spellcheck: 'false',
            onChange: (e) => { try { localStorage.setItem('ob.cfg.' + k, e.target.value.trim()); } catch (err) { /* ignorieren */ } render(sync.getStatus()); } }));
      }),
    ));
  }
  return card;
}
