import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, sheet, confirmDialog, pickFiles, UrlPool, coverColor, download, safeName } from './ui.js';
import { processCapture, processCover } from './imageproc.js';
import { openScanner } from './scanner.js';
import { openReader } from './reader.js';
import { openPageEditor } from './pageeditor.js';

const app = document.getElementById('app');
let cleanup = null;

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, () => renderLibrary()],
  [/^#\/book\/([\w]+)$/, (m) => renderBook(m[1])],
  [/^#\/scan\/([\w]+)$/, (m) => openScanner(app, m[1])],
  [/^#\/read\/([\w]+)$/, (m) => openReader(app, m[1])],
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

  const view = h('div', { class: 'page library' },
    h('header', { class: 'topbar' },
      h('h1', { class: 'brand' }, icon('book'), 'openBook'),
      h('div', { class: 'row gap-s' },
        iconButton('settings', 'Einstellungen & Sicherung', () => openSettings()),
        h('button', { class: 'btn primary', onClick: () => newBookDialog() }, icon('plus'), 'Buch'),
      ),
    ),
    h('div', { class: 'toolbar' }, h('h2', {}, 'Bibliothek'), sortSel),
    badge,
    grid,
  );
  app.append(view);

  async function fill() {
    pool.clear();
    const books = await db.getBooks();
    const sorters = {
      recent: (a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt),
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
  const off = db.onChange((e) => { if (e.type === 'book' || e.type === 'pages') fill(); });
  return () => { off(); badge._off(); pool.clear(); };
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
  const n = book.pageOrder.length;
  if (!n || !book.position) return 0;
  return Math.max(0, Math.min(1, book.position.ratio || 0));
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
    if (!book) return;
    const pages = await db.getPagesMeta(bookId);
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
          pages.length ? h('button', { class: 'btn primary', onClick: () => go(`#/read/${bookId}`) }, icon('book'), book.position ? 'Weiterlesen' : 'Lesen') : null,
          h('button', { class: 'btn', onClick: () => go(`#/scan/${bookId}`) }, icon('camera'), 'Seiten scannen'),
        ),
      ),
    );
    pagesGrid.replaceChildren(...(pages.length ? pages.map((p, i) => pageTile(p, i)) : [
      h('p', { class: 'muted pad' }, 'Noch keine Seiten. Tippe auf „Seiten scannen“.'),
    ]));
  }

  function pageTile(p, i) {
    const label = { pending: 'wartet', running: 'erkennt …', done: '', error: 'Fehler' }[p.ocrStatus] || '';
    return h('button', { class: 'page-tile', onClick: () => go(`#/page/${bookId}/${p.id}`), 'aria-label': `Seite ${i + 1} bearbeiten` },
      h('img', { src: pool.get(p.thumb), alt: '', loading: 'lazy' }),
      h('span', { class: 'page-no' }, i + 1),
      label ? h('span', { class: 'page-status ' + p.ocrStatus }, label) : null,
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
        const failed = pages.filter((p) => p.ocrStatus !== 'done');
        const ok = await confirmDialog('Text neu erkennen', failed.length
          ? `Nur die ${failed.length} nicht erkannten Seiten erneut erkennen?`
          : 'Alle Seiten erneut erkennen? Manuelle Textkorrekturen gehen dabei verloren.', 'Starten');
        if (!ok) return;
        const list = failed.length ? failed : pages;
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
          if (pages[0]) { cover = await processCover(pages[0].image); showPrev(); }
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
    if (e.bookId !== bookId) return;
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

  const s = sheet('Einstellungen', h('div', { class: 'stack' },
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
    h('p', { class: 'muted small' }, 'openBook speichert alles nur auf diesem Gerät. Die Texterkennung läuft lokal, es werden keine Fotos hochgeladen. Nur für Bücher, die dir selbst gehören.'),
  ));
}

// ---------- Start ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

route();
ocr.resume();
