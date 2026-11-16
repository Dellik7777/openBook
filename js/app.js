import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, pixels, toast, sheet, confirmDialog, promptDialog, pickFiles, UrlPool, coverColor, download, safeName } from './ui.js';
import { processCapture, processCover } from './imageproc.js';
import { openScanner } from './scanner.js';
import { openReader } from './reader.js';
import { openPageEditor } from './pageeditor.js';
import { openSend, openReceive } from './transferview.js';
import { openLegal } from './legalview.js';
import { openStats } from './statsview.js';
import * as profiles from './profiles.js';
import * as sync from './sync/sync.js';
import { clientId, redirectUri } from './sync/oauth.js';
import { checkPages, describe, orderByPrinted } from './pagecheck.js';
import { stripMd } from './rich.js';
import * as lock from './lock.js';
import * as vault from './vault.js';

// Darf ein Buch ohne Nachfrage gelesen werden? (gesperrt → entsperrt; verschlüsselt → Tresor offen)
const canOpenBook = (b) => (b.enc && vault.isSetup() ? vault.isOpen() : !b.locked || lock.isUnlocked() || !lock.isConfigured());
// Vor dem Sichern: verschlüsselte Bücher brauchen den offenen Tresor
async function vaultForBackup(bookIds = null) {
  const enc = (await db.getBooks()).filter((b) => b.enc && (!bookIds || bookIds.includes(b.id)));
  if (!enc.length || vault.isOpen()) return true;
  return lock.unlockVault('Gesperrte Bücher sind verschlüsselt. Zum Sichern bitte entsperren.');
}
import { searchLibrary, setJump } from './search.js';
import { bookSize, shrinkPhotos, deletePhotos, fmtBytes } from './storage.js';
import { getStats, dayKey } from './stats.js';

// Lesestatus je Profil: 'want' (will ich lesen), 'reading', 'done' (gelesen)
export const STATUS = { reading: 'Lese ich', want: 'Will ich lesen', done: 'Gelesen' };
export const statusOf = (st) => (st && st.status) || (st && st.lastOpenedAt ? 'reading' : null);
async function setStatus(bookId, status) {
  await db.updateState(profiles.currentId(), bookId, { status, statusAt: Date.now() }, { touch: false });
}

const app = document.getElementById('app');
let cleanup = null;

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, () => renderLibrary()],
  [/^#\/ordner\/([\w]+)$/, (m) => renderLibrary({ folderId: m[1] })],
  [/^#\/tag\/(.+)$/, (m) => renderLibrary({ tag: decodeURIComponent(m[1]) })],
  [/^#\/book\/([\w]+)$/, (m) => renderBook(m[1])],
  [/^#\/scan\/([\w]+)$/, (m) => openScanner(app, m[1])],
  [/^#\/scan\/([\w]+)\/nach\/([\w]+)(?:\/(\d+))?$/, (m) => openScanner(app, m[1], m[2], +(m[3] || 1))],
  [/^#\/read\/([\w]+)$/, (m) => openReader(app, m[1])],
  [/^#\/send\/([\w]+)$/, (m) => openSend(app, m[1])],
  [/^#\/receive$/, () => openReceive(app)],
  [/^#\/rechtliches$/, () => openLegal(app)],
  [/^#\/statistik$/, () => openStats(app)],
  [/^#\/lernen(?:\/([\w]+))?$/, async (m) => (await import('./cardsview.js')).openCards(app, m[1] || null)],
  [/^#\/page\/([\w]+)\/([\w]+)$/, (m) => openPageEditor(app, m[1], m[2])],
  [/^#\/pruefen\/([\w]+)$/, async (m) => (await import('./proofview.js')).openProof(app, m[1])],
];

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  // offene Dialoge/Sheets der vorherigen Ansicht schließen
  document.querySelectorAll('.backdrop, .figviewer').forEach((el) => el.remove());
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

async function renderLibrary({ folderId = null, tag = null } = {}) {
  const pool = new UrlPool();
  const badge = ocrBadge();
  const grid = h('div', { class: 'grid' });
  const results = h('div', { class: 'search-results', hidden: true });
  let sortMode = localStorage.getItem('ob.sort') || 'recent';
  let statusFilter = localStorage.getItem('ob.statusFilter') || '';
  const statusRow = h('div', { class: 'status-row', role: 'tablist', 'aria-label': 'Nach Lesestatus filtern' });
  const goalEl = h('div', { class: 'goal-wrap' });
  let query = sessionStorage.getItem('ob.q') || '';

  if (folderId && !(await db.getFolder(folderId))) { go('#/'); return; }

  const sortSel = h('select', { class: 'select', 'aria-label': 'Sortierung', onChange: (e) => { sortMode = e.target.value; localStorage.setItem('ob.sort', sortMode); fill(); } },
    h('option', { value: 'recent' }, 'Zuletzt gelesen'),
    h('option', { value: 'title' }, 'Titel'),
    h('option', { value: 'author' }, 'Autor'),
    h('option', { value: 'added' }, 'Hinzugefügt'),
  );
  sortSel.value = sortMode;
  const avatarBtn = h('button', { class: 'avatar-btn', 'aria-label': 'Profil wechseln', onClick: () => openProfiles() });
  const crumbs = h('h2', { class: 'crumbs' });
  const tagRow = h('div', { class: 'tag-row' });
  const syncIndicator = syncIndicatorEl();
  let multiProfile = (await db.getProfiles()).length > 1;
  function showProfile() {
    const p = profiles.current();
    avatarBtn.replaceChildren(avatar(p));
    avatarBtn.title = 'Profil: ' + (p ? p.name : '');
  }
  showProfile();

  const searchInput = h('input', { class: 'input search-input', type: 'search', placeholder: 'In allen Büchern suchen …', value: query, enterkeyhint: 'search', 'aria-label': 'In allen Büchern suchen' });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchInput.value; sessionStorage.setItem('ob.q', query); runSearch(); }, 250);
  });

  const view = h('div', { class: 'page library' },
    h('header', { class: 'topbar' },
      h('h1', { class: 'brand' }, pixels(), h('span', {}, 'Lese', h('span', { class: 'brand-accent' }, 'pixel'))),
      h('div', { class: 'row gap-s' },
        syncIndicator,
        iconButton('settings', 'Einstellungen & Sicherung', () => openSettings()),
        avatarBtn,
        h('button', { class: 'btn primary btn-add', 'aria-label': 'Neues Buch', onClick: () => newBookDialog(folderId) }, icon('plus'), h('span', { class: 'label' }, 'Buch')),
      ),
    ),
    usageCard(),
    await backupReminder(),
    goalEl,
    h('div', { class: 'search-wrap' }, icon('search'), searchInput),
    results,
    h('div', { class: 'lib-body' },
      h('div', { class: 'toolbar' }, crumbs,
        h('div', { class: 'row gap-s' },
          tag ? null : iconButton('folderPlus', 'Neuer Ordner', () => folderDialog(null, folderId)),
          sortSel)),
      tagRow,
      statusRow,
      badge,
      grid,
    ),
  );
  app.append(view);
  const body = view.querySelector('.lib-body');

  async function renderCrumbs() {
    const parts = [h('a', { href: '#/', class: folderId || tag ? '' : 'here' }, pixels('small'), multiProfile ? `Bibliothek · ${profiles.current().name.split(/\s+/)[0]}` : 'Bibliothek')];
    if (folderId) {
      const chain = [];
      let f = await db.getFolder(folderId);
      while (f) { chain.unshift(f); f = f.parentId ? await db.getFolder(f.parentId) : null; }
      for (const c of chain) parts.push(h('span', { class: 'sep' }, '›'), h('a', { href: '#/ordner/' + c.id, class: c.id === folderId ? 'here' : '' }, c.name));
    }
    if (tag) parts.push(h('span', { class: 'sep' }, '›'), h('span', { class: 'here tag-crumb' }, icon('tag'), tag));
    crumbs.replaceChildren(...parts);
  }

  async function fill() {
    pool.clear();
    await renderCrumbs();
    const [books, folders] = await Promise.all([db.getBooks(), db.getFolders()]);
    const folderIds = new Set(folders.map((f) => f.id));
    const states = new Map((await db.getStatesOfProfile(profiles.currentId())).map((st) => [st.bookId, st]));
    for (const b of books) b._state = states.get(b.id) || null;
    const opened = (b) => (b._state && b._state.lastOpenedAt) || b.createdAt;
    const sorters = {
      recent: (a, b) => opened(b) - opened(a),
      title: (a, b) => a.title.localeCompare(b.title, 'de'),
      author: (a, b) => (a.author || '').localeCompare(b.author || '', 'de') || a.title.localeCompare(b.title, 'de'),
      added: (a, b) => b.createdAt - a.createdAt,
    };
    // Tags (alle Bücher)
    const tagCount = new Map();
    for (const b of books) for (const t of b.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const tags = [...tagCount].sort((a, b) => a[0].localeCompare(b[0], 'de'));
    tagRow.hidden = !tags.length;
    tagRow.replaceChildren(...tags.map(([t, n]) => h('a', {
      class: 'tag-chip' + (t === tag ? ' on' : ''), href: t === tag ? (folderId ? '#/ordner/' + folderId : '#/') : '#/tag/' + encodeURIComponent(t),
    }, '#' + t, h('small', {}, n))));

    const inFolder = (b) => (folderIds.has(b.folderId) ? b.folderId : null) === folderId;
    // Statusfilter: in der obersten Ebene über alle Ordner hinweg
    const inTree = (b) => {
      if (!folderId) return true;
      let f = folderIds.has(b.folderId) ? b.folderId : null;
      while (f) { if (f === folderId) return true; const x = folders.find((y) => y.id === f); f = x && folderIds.has(x.parentId) ? x.parentId : null; }
      return false;
    };
    const counts = { reading: 0, want: 0, done: 0 };
    for (const b of books) { const st = statusOf(b._state); if (st && (tag ? (b.tags || []).includes(tag) : inTree(b))) counts[st]++; }
    statusRow.hidden = !books.length;
    statusRow.replaceChildren(...[['', 'Alle'], ...Object.entries(STATUS)].map(([k, label]) => h('button', {
      class: 'status-chip' + (statusFilter === k ? ' on' : ''), role: 'tab', 'aria-selected': String(statusFilter === k),
      onClick: () => { statusFilter = k; localStorage.setItem('ob.statusFilter', k); fill(); },
    }, label, k ? h('small', {}, counts[k]) : null)));
    const shown = books.filter((b) => {
      if (statusFilter) return statusOf(b._state) === statusFilter && (tag ? (b.tags || []).includes(tag) : inTree(b));
      return tag ? (b.tags || []).includes(tag) : inFolder(b);
    }).sort(sorters[sortMode] || sorters.recent);
    const subfolders = tag || statusFilter ? [] : folders.filter((f) => (folderIds.has(f.parentId) ? f.parentId : null) === folderId)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    renderGoal();

    const count = (fid) => {
      const ids = new Set([fid]);
      let grew = true;
      while (grew) { grew = false; for (const f of folders) if (ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
      return books.filter((b) => ids.has(b.folderId)).length;
    };

    if (!shown.length && !subfolders.length && statusFilter && books.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, `Keine Bücher unter „${STATUS[statusFilter]}“`),
        h('p', { class: 'muted' }, statusFilter === 'want' ? 'Markiere Bücher in den Buchdetails als „Will ich lesen“.' : statusFilter === 'done' ? 'Bücher, die du bis zum Ende liest, landen automatisch hier.' : 'Öffne ein Buch zum Lesen.'),
        h('button', { class: 'btn', onClick: () => { statusFilter = ''; localStorage.setItem('ob.statusFilter', ''); fill(); } }, 'Alle anzeigen')));
      return;
    }
    if (!shown.length && !subfolders.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        icon(folderId ? 'folder' : tag ? 'tag' : 'book', 'big'),
        h('h3', {}, folderId ? 'Dieser Ordner ist leer' : tag ? 'Keine Bücher mit diesem Tag' : 'Noch keine Bücher'),
        h('p', { class: 'muted' }, folderId
          ? 'Lege hier ein neues Buch an oder verschiebe Bücher über „⋯ → In Ordner verschieben“ hierher.'
          : 'Lege ein Buch an und fotografiere die Seiten. Lesepixel erkennt den Text und du kannst das Buch danach überall lesen, auch ohne Internet.'),
        tag ? null : h('button', { class: 'btn primary', onClick: () => newBookDialog(folderId) }, icon('plus'), folderId ? 'Buch hier anlegen' : 'Erstes Buch anlegen'),
      ));
      return;
    }
    grid.replaceChildren(
      ...subfolders.map((f) => folderTile(f, count(f.id))),
      ...shown.map((b) => bookTile(b, pool)),
    );
  }

  // Tagesziel (Leseminuten) des aktiven Profils
  async function renderGoal() {
    const p = profiles.current();
    const goal = p && p.goalMin;
    if (!goal) { goalEl.replaceChildren(); return; }
    const st = await getStats(p.id);
    const min = Math.floor(((st.days[dayKey()] || {}).sec || 0) / 60);
    const pct = Math.min(100, Math.round((min / goal) * 100));
    goalEl.replaceChildren(h('a', { class: 'goal' + (min >= goal ? ' done' : ''), href: '#/statistik', 'aria-label': `Tagesziel: ${min} von ${goal} Minuten` },
      icon(min >= goal ? 'check' : 'target'),
      h('span', { class: 'goal-text' }, min >= goal ? `Tagesziel erreicht – ${min} Min. gelesen` : `Heute ${min} von ${goal} Min. gelesen`),
      h('span', { class: 'goal-bar' }, h('span', { style: { width: pct + '%' } })),
    ));
  }

  async function runSearch() {
    const q = query.trim();
    body.hidden = q.length >= 2;
    results.hidden = q.length < 2;
    if (q.length < 2) { results.replaceChildren(); return; }
    results.replaceChildren(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Suche …'));
    const found = await searchLibrary(q, { canOpen: canOpenBook });
    if (query.trim() !== q) return;
    if (!found.length) { results.replaceChildren(h('p', { class: 'muted' }, `Nichts gefunden für „${q}“.`)); return; }
    const total = found.reduce((s, r) => s + r.total, 0);
    results.replaceChildren(
      h('p', { class: 'muted small' }, `${total} ${total === 1 ? 'Treffer' : 'Treffer'} in ${found.length} ${found.length === 1 ? 'Buch' : 'Büchern'}`),
      ...found.map((r) => h('div', { class: 'sr-book card' },
        h('button', { class: 'sr-title', onClick: () => openBook(r.book) }, h('strong', {}, r.book.title), r.book.author ? h('span', { class: 'muted small' }, ' · ' + r.book.author) : null,
          h('span', { class: 'muted small sr-count' }, r.total ? `${r.total}×` : 'im Titel/Tag')),
        ...r.hits.map((hit) => h('button', { class: 'sr-hit', onClick: async () => {
          if (!(await lock.ensureBookAccess(r.book))) return;
          setJump(r.book.id, hit);
          go('#/read/' + r.book.id);
        } },
          h('span', { class: 'sr-page' }, hit.printedNo ? `S. ${hit.printedNo}` : `Foto ${hit.pageIndex + 1}`),
          h('span', {}, hit.before, h('mark', {}, hit.match), hit.after))),
        r.total > r.hits.length ? h('p', { class: 'muted small' }, `… und ${r.total - r.hits.length} weitere – im Buch über die Lupe suchen.`) : null,
      )),
    );
  }

  await fill();
  if (query) runSearch();
  let t = null;
  const off = db.onChange((e) => {
    if (!['book', 'pages', 'sync', 'profile', 'folder', 'state'].includes(e.type)) return;
    clearTimeout(t);
    t = setTimeout(async () => { multiProfile = (await db.getProfiles()).length > 1; showProfile(); fill(); }, 100);
  });
  const offSwitch = profiles.onSwitch(() => { showProfile(); fill(); });
  return () => { off(); offSwitch(); badge._off(); syncIndicator._off(); pool.clear(); clearTimeout(t); clearTimeout(searchTimer); };
}

async function openBook(book) {
  if (!(await lock.ensureBookAccess(book))) return;
  go(book.pageOrder.length ? `#/read/${book.id}` : `#/book/${book.id}`);
}

function folderTile(f, n) {
  return h('div', { class: 'tile folder-tile' },
    h('a', { class: 'tile-main', href: '#/ordner/' + f.id, 'aria-label': `Ordner ${f.name} öffnen` },
      h('div', { class: 'folder-cover' }, icon('folder'), h('span', { class: 'folder-count' }, n === 1 ? '1 Buch' : `${n} Bücher`)),
    ),
    h('div', { class: 'tile-info' },
      h('div', { class: 'tile-text' }, h('div', { class: 'tile-title' }, f.name)),
      iconButton('more', 'Ordner bearbeiten', () => folderDialog(f), 'small'),
    ),
  );
}

// Ordner anlegen / umbenennen / löschen
async function folderDialog(folder, parentId = null) {
  const name = h('input', { class: 'input', value: folder ? folder.name : '', placeholder: 'Name des Ordners', maxlength: 60 });
  const s = sheet(folder ? 'Ordner bearbeiten' : 'Neuer Ordner', h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    if (folder) await db.putFolder({ ...folder, name: n });
    else await db.createFolder(n, parentId);
    s.close();
  } },
    name,
    h('button', { class: 'btn primary block', type: 'submit' }, folder ? 'Speichern' : 'Ordner anlegen'),
    folder ? h('button', { type: 'button', class: 'btn danger block', onClick: async () => {
      if (!(await confirmDialog('Ordner löschen?', 'Die Bücher und Unterordner darin bleiben erhalten und wandern eine Ebene nach oben.', 'Löschen', true))) return;
      const parent = folder.parentId;
      await db.deleteFolder(folder.id);
      s.close();
      if (location.hash === '#/ordner/' + folder.id) go(parent ? '#/ordner/' + parent : '#/');
    } }, icon('trash'), 'Ordner löschen') : null,
  ));
  setTimeout(() => name.focus(), 250);
}

// Ordnerauswahl (eingerückt nach Ebene)
async function folderOptions(selected) {
  const folders = await db.getFolders();
  const byParent = new Map();
  for (const f of folders) {
    const k = folders.some((x) => x.id === f.parentId) ? f.parentId : null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  const opts = [h('option', { value: '' }, 'Bibliothek (kein Ordner)')];
  const walk = (pid, depth) => {
    for (const f of (byParent.get(pid) || []).sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      opts.push(h('option', { value: f.id }, ' '.repeat(depth) + '▸ ' + f.name));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  const sel = h('select', { class: 'input' }, ...opts);
  sel.value = selected || '';
  return sel;
}

// Tag-Eingabe: vorhandene Tags antippen oder neue eintippen (Komma/Enter)
async function tagEditor(initial) {
  let tags = [...(initial || [])];
  const all = new Set();
  for (const b of await db.getBooks()) for (const t of b.tags || []) all.add(t);
  const chips = h('div', { class: 'tag-edit' });
  const input = h('input', { class: 'input', placeholder: 'Tag hinzufügen …', autocomplete: 'off' });
  const sugg = h('div', { class: 'tag-row' });
  const norm = (t) => t.replace(/^#/, '').trim().replace(/\s+/g, '-').slice(0, 30);
  const render = () => {
    chips.replaceChildren(...tags.map((t) => h('button', { type: 'button', class: 'tag-chip on', onClick: () => { tags = tags.filter((x) => x !== t); render(); } }, '#' + t, ' ×')));
    sugg.replaceChildren(...[...all].filter((t) => !tags.includes(t)).sort().map((t) => h('button', { type: 'button', class: 'tag-chip', onClick: () => { tags.push(t); render(); } }, '#' + t)));
  };
  const add = () => {
    for (const part of input.value.split(',')) { const t = norm(part); if (t && !tags.includes(t)) tags.push(t); }
    input.value = '';
    render();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } });
  input.addEventListener('blur', add);
  render();
  const el = h('div', { class: 'stack-s' }, chips, input, sugg);
  el.value = () => { add(); return tags; };
  return el;
}

// Erinnerung an die Sicherung
async function backupReminder() {
  const books = await db.getBooks();
  if (!books.length) return null;
  const last = (await db.getMeta('lastBackupAt', 0)) || 0;
  let snooze = 0;
  try { snooze = +localStorage.getItem('ob.backupSnooze') || 0; } catch (e) { /* */ }
  if (Date.now() < snooze) return null;
  const changed = books.filter((b) => (b.orderAt || b.createdAt || 0) > last).length;
  const pages = books.reduce((n, b) => n + b.pageOrder.length, 0);
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const due = last ? (changed && days >= 14) : pages >= 20;
  if (!due) return null;
  const card = h('div', { class: 'card notice' },
    h('strong', {}, 'Zeit für eine Sicherung'),
    h('p', { class: 'small' }, last
      ? `Letzte Sicherung vor ${days} Tagen – seitdem ${changed === 1 ? 'hat sich 1 Buch' : `haben sich ${changed} Bücher`} geändert.`
      : `Du hast ${pages} Seiten gescannt, aber noch keine Sicherung erstellt. Fotos liegen nur auf diesem Gerät.`),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn small primary', onClick: async () => {
        if (!(await vaultForBackup())) return;
        const { exportBackup } = await import('./backup.js');
        toast('Sicherung wird erstellt …');
        const blob = await exportBackup();
        download(blob, `lesepixel-sicherung-${new Date().toISOString().slice(0, 10)}.lesepixel.zip`);
        card.remove();
      } }, icon('download'), 'Jetzt sichern'),
      h('button', { class: 'btn small', onClick: () => { try { localStorage.setItem('ob.backupSnooze', String(Date.now() + 7 * 86400000)); } catch (e) { /* */ } card.remove(); } }, 'In einer Woche erinnern'),
    ),
  );
  return card;
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
      onClick: () => openBook(book),
    },
      coverEl(book, pool, book.locked && lock.isConfigured() ? 'locked' : ''),
      book.locked && lock.isConfigured() ? h('span', { class: 'lock-badge' }, icon('lock')) : null,
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
    ),
    h('div', { class: 'tile-info' },
      h('div', { class: 'tile-text' },
        h('div', { class: 'tile-title' }, book.title),
        h('div', { class: 'tile-meta' }, statusOf(book._state) === 'done' ? h('span', { class: 'st-done' }, icon('check'), ` Gelesen · ${n} S.`)
          : statusOf(book._state) === 'want' ? `Will ich lesen · ${n} S.` : n ? `${pct} % · ${n} S.` : 'Noch keine Seiten'),
      ),
      iconButton('more', 'Buchdetails', async () => { if (await lock.ensureBookAccess(book)) go(`#/book/${book.id}`); }, 'small'),
    ),
  );
}

// ---------- Neues Buch ----------

function newBookDialog(folderId = null) {
  let coverBlob = null;
  let isbn = null;
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
  const isbnInfo = h('p', { class: 'muted small', hidden: true });
  const scanIsbnBtn = async () => {
    const { scanIsbn, lookupIsbn } = await import('./isbn.js');
    const code = await scanIsbn();
    if (!code) return;
    isbn = code;
    isbnInfo.hidden = false;
    isbnInfo.replaceChildren(h('span', { class: 'spinner' }), ` ISBN ${code} – suche Titel …`);
    try {
      const r = await lookupIsbn(code);
      if (!r) { isbnInfo.textContent = `ISBN ${code} gelesen, aber in keinem Katalog gefunden (oder keine Verbindung). Bitte Titel eintippen – die ISBN wird trotzdem gespeichert.`; title.focus(); return; }
      title.value = r.title;
      author.value = r.author || author.value;
      if (r.cover) { coverBlob = await processCover(r.cover); preview.replaceChildren(h('img', { src: pool.get(coverBlob), alt: 'Cover' })); }
      isbnInfo.textContent = `ISBN ${code} · gefunden bei ${r.source}${r.cover ? '' : ' (ohne Cover)'}`;
    } catch (err) {
      isbnInfo.textContent = `ISBN ${code} gespeichert. Nachschlagen nicht möglich: ${err.message}`;
    }
  };
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (!title.value.trim()) { title.focus(); return; }
    const book = await db.createBook({ title: title.value.trim(), author: author.value.trim(), cover: coverBlob });
    if (folderId || isbn) await db.updateBook(book.id, { ...(folderId ? { folderId } : {}), ...(isbn ? { isbn } : {}) });
    db.requestPersistence();
    s.close();
    go(`#/scan/${book.id}`);
  } },
    h('div', { class: 'row gap-s wrap new-quick' },
      h('button', { type: 'button', class: 'btn small', onClick: scanIsbnBtn }, icon('barcode'), 'ISBN scannen'),
      h('button', { type: 'button', class: 'btn small', onClick: () => { s.close(); importDialog(folderId); } }, icon('fileIn'), 'PDF/EPUB importieren'),
    ),
    isbnInfo,
    h('button', { type: 'button', class: 'cover-pick-btn', onClick: pickCover }, preview),
    title, author,
    h('button', { class: 'btn primary block', type: 'submit' }, icon('camera'), 'Anlegen & Seiten scannen'),
    h('p', { class: 'muted small' }, 'ISBN scannen sucht Titel, Autor und Cover online (es wird nur die ISBN an Open Library, die Deutsche Nationalbibliothek, lobid und Google Books gesendet).'),
  );
  const s = sheet('Neues Buch', form, { onClose: () => pool.clear() });
  setTimeout(() => title.focus(), 250);
}

// ---------- PDF/EPUB importieren ----------

async function importDialog(folderId = null) {
  const { ACCEPT, kindOf } = await import('./importer.js');
  const [file] = await pickFiles({ accept: ACCEPT, multiple: false });
  if (!file) return;
  const kind = kindOf(file);
  if (!kind) { toast('Bitte eine PDF- oder EPUB-Datei wählen'); return; }
  const keep = h('input', { type: 'checkbox', checked: true });
  const bar = h('div', { class: 'progress big' }, h('div', { style: { width: '0%' } }));
  const info = h('p', { class: 'muted small' });
  const ctl = new AbortController();
  let running = false;
  const start = async () => {
    running = true;
    startBtn.disabled = true;
    opts.hidden = true;
    progress.hidden = false;
    db.requestPersistence();
    const mod = await import('./importer.js');
    const onProgress = (r, txt) => { bar.firstChild.style.width = Math.round(r * 100) + '%'; info.textContent = txt; };
    try {
      const res = kind === 'pdf'
        ? await mod.importPdf(file, { folderId, keepImages: keep.checked, onProgress, signal: ctl.signal, askPassword: (wrong) => promptDialog('PDF mit Kennwort', wrong ? 'Kennwort falsch – bitte erneut eingeben.' : 'Dieses PDF ist geschützt.', { type: 'password', okLabel: 'Öffnen' }) })
        : await mod.importEpub(file, { folderId, onProgress, signal: ctl.signal });
      running = false;
      s.close();
      toast(ctl.signal.aborted ? 'Import abgebrochen – bisherige Seiten bleiben erhalten'
        : kind === 'pdf' ? `${res.pages} Seiten importiert` + (res.scanned ? ` · ${res.scanned} ohne Text werden erkannt` : '')
          : `${res.pages} Abschnitte importiert` + (res.figures ? ` · ${res.figures} Abbildungen` : ''), 4000);
      go('#/book/' + res.bookId);
    } catch (e) {
      running = false;
      console.error(e);
      info.textContent = 'Import fehlgeschlagen: ' + (e && e.name === 'PasswordException' ? 'Kennwort fehlt' : e.message);
      startBtn.disabled = false;
    }
  };
  const opts = h('div', { class: 'stack' },
    h('p', {}, h('strong', {}, file.name), h('br'), h('span', { class: 'muted small' }, `${kind.toUpperCase()} · ${fmtBytes(file.size)}`)),
    kind === 'pdf' ? h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Seitenbilder behalten'), h('br'),
      h('span', { class: 'muted small' }, 'Für die Originalansicht (Formeln, Grafiken). Braucht mehr Speicher. Seiten ohne Textebene behalten ihr Bild immer.')), keep) : null,
    kind === 'epub' ? h('p', { class: 'muted small' }, 'Kapitel, Überschriften, Bilder, Tabellen und Fußnoten werden übernommen. Kopiergeschützte (DRM) EPUBs lassen sich nicht importieren.') : null,
    h('p', { class: 'muted small' }, 'Nur für Dateien, die dir gehören bzw. die du nutzen darfst. Die Datei bleibt auf diesem Gerät.'),
  );
  const progress = h('div', { class: 'stack', hidden: true }, bar, info,
    h('button', { class: 'btn small', onClick: () => ctl.abort() }, 'Abbrechen'));
  const startBtn = h('button', { class: 'btn primary block', onClick: start }, icon('fileIn'), 'Importieren');
  const s = sheet(kind === 'pdf' ? 'PDF importieren' : 'EPUB importieren', h('div', { class: 'stack' }, opts, progress, startBtn),
    { onClose: () => { if (running) ctl.abort(); } });
}

// ---------- Buchdetails ----------

async function renderBook(bookId) {
  const pool = new UrlPool();
  let book = await db.getBook(bookId);
  if (!book) { go('#/'); return; }
  if (!(await lock.ensureBookAccess(book))) { go('#/'); return; }
  const badge = ocrBadge();
  const head = h('div', { class: 'book-head' });
  const pagesGrid = h('div', { class: 'pages-grid' });
  const issuesCard = h('div', { class: 'card issues', hidden: true });
  const proofCard = h('div', { class: 'card issues proof-card', hidden: true });

  const view = h('div', { class: 'page book' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => go(book.folderId ? '#/ordner/' + book.folderId : '#/')),
      h('div', { class: 'grow' }),
      iconButton('more', 'Weitere Aktionen', () => bookActions()),
    ),
    head,
    badge,
    h('div', { class: 'toolbar' }, h('h2', {}, pixels('small'), 'Seiten'),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'btn small', onClick: () => importImages() }, icon('images'), 'Fotos importieren'),
      ),
    ),
    issuesCard,
    proofCard,
    pagesGrid,
  );
  app.append(view);

  async function importImages() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.lastModified - b.lastModified);
    const split = await confirmDialog('Doppelseiten?', 'Zeigen die Fotos jeweils zwei Buchseiten nebeneinander? Dann teilt Lesepixel jedes Foto in eine linke und rechte Seite.', 'Ja, teilen');
    const scanFilter = localStorage.getItem('ob.scanFilter') !== '0';
    toast(`${files.length} Fotos werden verarbeitet …`);
    let n = 0;
    for (const f of files) {
      const parts = await processCapture(f, { split, scanFilter, autoCrop: localStorage.getItem('ob.autoCrop') !== '0' });
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
    const pages = await db.getPagesMeta(bookId, { images: false });
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
          `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} · ${done} erkannt` + (errs ? ` · ${errs} Fehler` : '') + (words ? ` · ca. ${Math.max(1, Math.round(words / 250))} Min. Lesezeit` : '') + ` · ${fmtBytes((await bookSize(bookId)).total)}`,
        ),
        await metaChips(),
        statusChips(state),
        h('div', { class: 'row gap-s wrap' },
          pages.length ? h('button', { class: 'btn primary', onClick: () => go(`#/read/${bookId}`) }, icon('book'), state && state.position ? 'Weiterlesen' : 'Lesen') : null,
          h('button', { class: 'btn', onClick: () => go(`#/scan/${bookId}`) }, icon('camera'), 'Seiten scannen'),
        ),
      ),
    );
    const figs = await db.getFiguresOfBook(bookId);
    figPages = new Set(figs.map((f) => f.pageId));
    renderIssues(pages);
    renderProof(pages);
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
    const hasOrder = all.some((is) => is.type === 'order');
    const ignore = async (key) => { await db.updateBook(bookId, (b) => ({ ignoredGaps: [...new Set([...(b.ignoredGaps || []), key])] })); };
    issuesCard.replaceChildren(
      h('strong', {}, all.length === 1 ? 'Seitenprüfung: 1 Hinweis' : `Seitenprüfung: ${all.length} Hinweise`),
      hasOrder ? h('div', { class: 'issue' }, h('span', { class: 'grow' }, 'Einige Seiten stehen nicht in der Reihenfolge ihrer Seitenzahlen.'),
        h('button', { class: 'btn small primary', onClick: () => sortByNumbers() }, icon('sort'), 'Nach Seitenzahl ordnen')) : null,
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

  // Textprüfung: wahrscheinliche Lesefehler im ganzen Buch zählen
  let proofRun = 0;
  async function renderProof(pages) {
    const run = ++proofRun;
    const done = pages.filter((p) => p.ocrStatus === 'done' && p.text);
    if (!done.length) { proofCard.hidden = true; return; }
    const { analyzeBook } = await import('./proofread.js');
    const r = await analyzeBook(done, { ignored: book.proofIgnore || [] });
    if (run !== proofRun) return;
    const auto = new Set(r.fixes.map((f) => f.from)).size, rev = new Set(r.review.map((x) => x.word)).size;
    if (!auto && !rev) {
      proofCard.hidden = false;
      proofCard.className = 'card issues ok proof-card';
      proofCard.replaceChildren(h('span', { class: 'row gap-s' }, icon('check'), 'Textprüfung: keine zweifelhaften Wörter gefunden.'));
      return;
    }
    proofCard.hidden = false;
    proofCard.className = 'card issues proof-card';
    const parts = [];
    if (auto) parts.push(`${auto} eindeutige Lesefehler (werden automatisch korrigiert)`);
    if (rev) parts.push(`${rev} zweifelhafte Wörter zum Ansehen`);
    proofCard.replaceChildren(h('div', { class: 'issue' },
      h('span', { class: 'grow' }, h('strong', {}, 'Textprüfung: '), parts.join(', ') + '.'),
      h('button', { class: 'btn small primary', onClick: () => go('#/pruefen/' + bookId) }, icon('check'), 'Prüfen')));
  }

  function pageTile(p, i) {
    const label = { pending: 'wartet', running: 'erkennt …', done: '', error: 'Fehler', remote: 'anderes Gerät' }[p.ocrStatus] || '';
    return h('button', { class: 'page-tile', onClick: () => go(`#/page/${bookId}/${p.id}`), 'aria-label': `Seite ${i + 1} bearbeiten` },
      p.thumb
        ? h('img', { src: pool.get(p.thumb), alt: '', loading: 'lazy' })
        : h('span', { class: 'page-textthumb' }, stripMd(p.text || '').slice(0, 220)),
      h('span', { class: 'page-no' }, p.printedNo ? `S. ${p.printedNo}` : i + 1),
      label ? h('span', { class: 'page-status ' + p.ocrStatus }, label) : null,
      figPages.has(p.id) ? h('span', { class: 'page-fig', title: 'Enthält Abbildung' }, icon('figure')) : null,
      !label && (p.uncertain || []).length ? h('span', { class: 'page-status check', title: 'Unsicher erkannte Wörter prüfen' }, `${p.uncertain.length} prüfen`) : null,
    );
  }

  function statusChips(state) {
    const cur = statusOf(state);
    return h('div', { class: 'status-row small-row', role: 'group', 'aria-label': 'Lesestatus' },
      ...Object.entries({ want: STATUS.want, reading: STATUS.reading, done: STATUS.done }).map(([k, label]) => h('button', {
        class: 'status-chip' + (cur === k ? ' on' : ''), 'aria-pressed': String(cur === k),
        onClick: async () => { await setStatus(bookId, cur === k ? null : k); fillHead(); },
      }, k === 'done' ? icon('check') : null, label)));
  }

  async function sortByNumbers() {
    const pages = await db.getPagesMeta(bookId);
    const order = orderByPrinted(pages);
    if (!order) { toast('Die Seiten stehen schon in der richtigen Reihenfolge'); return; }
    const moved = order.filter((id, i) => id !== pages[i].id).length;
    const withNo = pages.filter((p) => p.printedNo).length;
    if (!(await confirmDialog('Nach Seitenzahl ordnen?', `${moved} Seiten bekommen einen neuen Platz. ${withNo} von ${pages.length} Seiten haben eine erkannte Seitenzahl; Seiten ohne Zahl bleiben hinter ihrer Vorgängerseite.`, 'Ordnen'))) return;
    const before = book.pageOrder;
    await db.updateBook(bookId, { pageOrder: order });
    toast('Seiten neu geordnet');
    showUndo(() => db.updateBook(bookId, { pageOrder: before }));
  }
  function showUndo(fn) {
    const bar = h('div', { class: 'undo-bar' }, h('span', {}, 'Neu geordnet.'), h('button', { class: 'btn small', onClick: async () => { await fn(); bar.remove(); toast('Rückgängig gemacht'); } }, icon('undo'), 'Rückgängig'));
    view.append(bar);
    setTimeout(() => bar.remove(), 10000);
  }

  async function metaChips() {
    const folder = book.folderId ? await db.getFolder(book.folderId) : null;
    const items = [];
    if (folder) items.push(h('a', { class: 'tag-chip folder-chip', href: '#/ordner/' + folder.id }, icon('folder'), folder.name));
    for (const t of book.tags || []) items.push(h('a', { class: 'tag-chip', href: '#/tag/' + encodeURIComponent(t) }, '#' + t));
    if (book.locked && lock.isConfigured()) items.push(h('span', { class: 'tag-chip' }, icon('lock'), book.enc ? 'gesperrt · verschlüsselt' : 'gesperrt'));
    return items.length ? h('div', { class: 'tag-row' }, ...items) : null;
  }

  function bookActions() {
    const s = sheet('Buch', h('div', { class: 'menu' },
      h('button', { class: 'menu-item', onClick: () => { s.close(); editMeta(); } }, icon('edit'), 'Titel, Autor, Cover, Ordner & Tags'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const sel = await folderOptions(book.folderId);
        const m = sheet('In Ordner verschieben', h('div', { class: 'stack' }, sel,
          h('button', { class: 'btn primary block', onClick: async () => { await db.updateBook(bookId, { folderId: sel.value || null }); m.close(); toast('Verschoben'); } }, icon('folder'), 'Verschieben'),
          h('button', { class: 'btn block', onClick: () => { m.close(); folderDialog(null, null); } }, icon('folderPlus'), 'Neuen Ordner anlegen')));
      } }, icon('folder'), 'In Ordner verschieben'),
      h('button', { class: 'menu-item', onClick: () => { s.close(); go('#/lernen/' + bookId); } }, icon('cards'), 'Lernkarten aus Markierungen üben'),
      h('button', { class: 'menu-item', onClick: () => { s.close(); sortByNumbers(); } }, icon('sort'), 'Seiten nach Seitenzahl ordnen'),
      h('button', { class: 'menu-item', onClick: () => { s.close(); storageDialog(); } }, icon('storage'), 'Speicher sparen'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const { exportEpub } = await import('./epub.js');
        toast('EPUB wird erstellt …');
        const blob = await exportEpub(bookId);
        download(blob, safeName(book.title) + '.epub');
      } }, icon('download'), 'Als EPUB exportieren (z. B. für Kindle)'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        const { exportPdf } = await import('./pdf.js');
        toast('PDF wird erstellt …');
        const blob = await exportPdf(bookId, (r) => { if (r < 1) toast(`PDF wird erstellt … ${Math.round(r * 100)} %`, 1500); });
        download(blob, safeName(book.title) + '.pdf');
      } }, icon('pdf'), 'Als durchsuchbares PDF exportieren'),
      h('button', { class: 'menu-item', onClick: () => { s.close(); go(`#/send/${bookId}`); } }, icon('wifi'), 'An eigenes Gerät senden (WLAN, ohne Internet)'),
      h('button', { class: 'menu-item', onClick: async () => {
        s.close();
        if (!(await vaultForBackup([bookId]))) return;
        const { exportBackup } = await import('./backup.js');
        toast('Sicherung wird erstellt …');
        const blob = await exportBackup([bookId]);
        download(blob, safeName(book.title) + '.lesepixel.zip');
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
      h('button', { class: 'menu-item', onClick: () => { s.close(); go('#/pruefen/' + bookId); } }, icon('check'), 'Text prüfen (Lesefehler finden)'),
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

  async function storageDialog() {
    const size = await bookSize(bookId);
    const pages = await db.getPagesMeta(bookId);
    const notDone = pages.filter((p) => p.image && p.ocrStatus !== 'done').length;
    const status = h('p', { class: 'muted small' });
    const s = sheet('Speicher sparen', h('div', { class: 'stack' },
      h('p', {}, `Dieses Buch belegt ${fmtBytes(size.total)}, davon Seitenfotos ${fmtBytes(size.photos)}.`),
      h('div', { class: 'card' },
        h('strong', {}, 'Fotos verkleinern'),
        h('p', { class: 'muted small' }, 'Fotos werden auf eine kleinere Größe gebracht. Die Originalansicht bleibt gut lesbar, spart meist 50–70 %.'),
        h('button', { class: 'btn small', disabled: !size.photos, onClick: async () => {
          status.textContent = 'Wird verkleinert …';
          const saved = await shrinkPhotos(bookId, (r) => { status.textContent = `Wird verkleinert … ${Math.round(r * 100)} %`; });
          status.textContent = `Fertig – ${fmtBytes(saved)} gespart.`;
        } }, 'Verkleinern')),
      h('div', { class: 'card' },
        h('strong', {}, 'Fotos löschen, Text behalten'),
        h('p', { class: 'muted small' }, 'Nur der erkannte Text, Abbildungen und kleine Vorschaubilder bleiben. Die Originalansicht und „Neu erkennen“ gehen danach nicht mehr.' + (notDone ? ` ${notDone} noch nicht erkannte Seiten behalten ihr Foto.` : '')),
        h('button', { class: 'btn small danger', disabled: !size.photos, onClick: async () => {
          if (!(await confirmDialog('Fotos löschen?', 'Das lässt sich nicht rückgängig machen. Tipp: vorher „Buch sichern“.', 'Fotos löschen', true))) return;
          const saved = await deletePhotos(bookId);
          status.textContent = `Fertig – ${fmtBytes(saved)} frei.`;
        } }, icon('trash'), 'Fotos löschen')),
      status,
    ));
    void s;
  }

  async function editMeta() {
    let cover = book.cover;
    const p2 = new UrlPool();
    const title = h('input', { class: 'input', value: book.title });
    const author = h('input', { class: 'input', value: book.author || '', placeholder: 'Autor:in' });
    const isbnIn = h('input', { class: 'input', value: book.isbn || '', placeholder: 'ISBN (optional)', inputmode: 'numeric' });
    const prev = h('div', { class: 'cover-pick' });
    const showPrev = () => prev.replaceChildren(cover ? h('img', { src: p2.get(cover), alt: '' }) : h('span', {}, icon('camera'), ' Cover fotografieren'));
    showPrev();
    const folderSel = await folderOptions(book.folderId);
    const tagsEl = await tagEditor(book.tags);
    const lockBox = lock.isConfigured() ? h('input', { type: 'checkbox', checked: !!book.locked }) : null;
    const s = sheet('Buch bearbeiten', h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      // Sperren/Entsperren ver- bzw. entschlüsselt das Buch → Tresor muss offen sein
      if (lockBox && lockBox.checked !== !!book.locked && lock.vaultReady() && !lock.vaultOpen()
        && !(await lock.unlockVault(lockBox.checked ? 'Zum Verschlüsseln des Buchs bitte entsperren.' : 'Zum Entschlüsseln bitte entsperren.'))) return;
      const { normalizeIsbn } = await import('./barcode.js');
      const isbnVal = isbnIn.value.trim() ? normalizeIsbn(isbnIn.value) : null;
      if (isbnIn.value.trim() && !isbnVal) { toast('Die ISBN ist ungültig'); isbnIn.focus(); return; }
      await db.updateBook(bookId, {
        isbn: isbnVal,
        title: title.value.trim() || book.title, author: author.value.trim(), cover,
        folderId: folderSel.value || null, tags: tagsEl.value(), locked: lockBox ? lockBox.checked : !!book.locked,
      });
      s.close();
      if (lockBox) { await lock.reconcile(); if (lockBox.checked && lock.vaultReady()) toast('Buch gesperrt und verschlüsselt'); }
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
      h('div', { class: 'row gap-s' }, isbnIn,
        h('button', { type: 'button', class: 'btn small', onClick: async () => {
          const { normalizeIsbn } = await import('./barcode.js');
          const code = normalizeIsbn(isbnIn.value);
          if (!code) { const { scanIsbn } = await import('./isbn.js'); const c = await scanIsbn(); if (c) isbnIn.value = c; return; }
          const { lookupIsbn } = await import('./isbn.js');
          toast('Suche …');
          try {
            const r = await lookupIsbn(code);
            if (!r) { toast('Kein Eintrag gefunden'); return; }
            title.value = r.title; if (r.author) author.value = r.author;
            if (r.cover) { cover = await processCover(r.cover); showPrev(); }
            toast('Gefunden bei ' + r.source);
          } catch (err) { toast(err.message); }
        } }, icon('barcode'), 'Nachschlagen')),
      h('label', { class: 'stack-s small' }, h('strong', {}, 'Ordner'), folderSel),
      h('div', { class: 'stack-s small' }, h('strong', {}, 'Tags'), tagsEl),
      lockBox
        ? h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Buch sperren'), h('br'), h('span', { class: 'muted small' }, 'Öffnen nur mit Face ID oder PIN. Texte, Fotos und Markierungen werden auf diesem Gerät verschlüsselt gespeichert.')), lockBox)
        : h('p', { class: 'muted small' }, 'Bücher sperren: zuerst unter Einstellungen → App-Sperre Face ID bzw. eine PIN einrichten.'),
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
  const lockEl = await lockCard();
  const autoCropBox = h('input', { type: 'checkbox', checked: localStorage.getItem('ob.autoCrop') !== '0',
    onChange: (e) => localStorage.setItem('ob.autoCrop', e.target.checked ? '1' : '0') });
  const s = sheet('Einstellungen', h('div', { class: 'stack' },
    syncEl,
    h('a', { class: 'card card-link', href: '#/statistik', onClick: () => s.close() }, h('strong', {}, icon('stats'), ' Lesestatistik & Tagesziel'), h('span', { class: 'muted small' }, 'Lesezeit pro Tag, Tage in Folge, meistgelesene Bücher')),
    h('a', { class: 'card card-link', href: '#/lernen', onClick: () => s.close() }, h('strong', {}, icon('cards'), ' Lernkarten'), h('span', { class: 'muted small' }, 'Aus deinen Markierungen in allen Büchern – mit Wiederholung nach dem Karteikasten-Prinzip')),
    lockEl,
    h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Seiten gerade rücken'), h('br'), h('span', { class: 'muted small' }, 'Seite im Foto finden, Tisch abschneiden, schräge Aufnahmen und Wölbung zur Buchmitte ausgleichen.')), autoCropBox),
    h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Sprache der Texterkennung'), h('br'), h('span', { class: 'muted small' }, 'Nur Deutsch erkennt Umlaute am besten. „Text neu erkennen“ im Buchmenü wendet die Änderung auf vorhandene Seiten an.')),
      (() => { const sel = h('select', { class: 'select', onChange: (e) => { ocr.setLanguages(e.target.value); toast('Sprache: ' + ocr.LANG_OPTIONS[e.target.value]); } },
        ...Object.entries(ocr.LANG_OPTIONS).map(([k, v]) => h('option', { value: k }, v))); sel.value = ocr.getLanguages(); return sel; })()),
    h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Scan-Filter'), h('br'), h('span', { class: 'muted small' }, 'Fotos in Graustufen mit hellem Papier speichern. Bessere Erkennung, weniger Speicher.')), scanFilter),
    h('div', { class: 'card' },
      h('strong', {}, 'Speicher'),
      h('p', { class: 'muted small' },
        est ? `Belegt: ${fmt(est.usage || 0)} von ca. ${fmt(est.quota || 0)}. ` : '',
        persisted ? 'Dauerhafter Speicher ist aktiv.' : 'Der Browser darf Daten bei Platzmangel löschen. Mach regelmäßig eine Sicherung.',
      ),
      !persisted ? h('button', { class: 'btn small', onClick: async () => {
        const ok = await db.requestPersistence();
        toast(ok ? 'Dauerhafter Speicher aktiviert' : 'Der Browser hat das abgelehnt. Installiere Lesepixel auf dem Startbildschirm.');
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
          if (!(await vaultForBackup())) return;
          const { exportBackup } = await import('./backup.js');
          toast('Sicherung wird erstellt …');
          const blob = await exportBackup();
          download(blob, `lesepixel-sicherung-${new Date().toISOString().slice(0, 10)}.lesepixel.zip`);
        } }, icon('download'), 'Alles sichern'),
        h('button', { class: 'btn small', onClick: async () => {
          const [f] = await pickFiles({ accept: '.zip,.openbook,.lesepixel,application/zip', multiple: false });
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
    h('p', { class: 'muted small' }, 'Die Texterkennung läuft lokal. Fotos werden nur hochgeladen, wenn du „Fotos mitsichern“ einschaltest. Ohne Synchronisierung bleibt alles nur auf diesem Gerät.'),
    h('a', { class: 'btn small', href: '#/rechtliches', onClick: () => s.close() }, 'Rechtliches: Nutzung, Datenschutz, Lizenzen'),
  ), { onClose: () => syncEl._off() });
}

// ---------- Start ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

(async () => {
  try {
    await profiles.ensureProfile();
    lock.init();
    // Tresor geöffnet → gesperrte Bücher (ent)schlüsseln, wartende Texterkennung und Sync nachholen
    vault.onChange((open) => { if (open) { lock.reconcile().then(() => { ocr.resume(); sync.syncNow(); }); } });
    db.onChange((e) => { if (e.type === 'sync' && vault.isOpen()) lock.reconcile(); });
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
        h('p', { class: 'muted small' }, 'Texte, Lesepositionen, Lesezeichen, Markierungen, Lernkarten, Lesestatistik und Profile auf all deinen Geräten abgleichen – über deinen eigenen Cloud-Speicher. Fotos nur, wenn du es einschaltest.'),
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
      const photoBox = h('input', { type: 'checkbox', checked: sync.photosEnabled(), onChange: async (e) => {
        if (e.target.checked && !(await confirmDialog('Fotos mitsichern?', 'Alle Seitenfotos werden zusätzlich in deinen Cloud-Speicher geladen (ca. 0,3 MB pro Seite). Auf anderen Geräten mit derselben Einstellung erscheinen sie dann auch. Gesperrte Bücher sind ausgenommen.', 'Einschalten'))) { e.target.checked = false; return; }
        sync.setPhotos(e.target.checked);
        toast(e.target.checked ? 'Fotos werden nach und nach hochgeladen' : 'Fotos werden nicht mehr gesichert');
      } });
      card.append(
        h('p', { class: 'small' }, `${prov.label}${prov.account() ? ' · ' + prov.account() : ''}`),
        h('p', { class: 'muted small' }, lines[st.state] || ''),
        h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Fotos mitsichern'), h('br'),
          h('span', { class: 'muted small' }, 'Seitenfotos als Sicherung in der Cloud – und auf anderen Geräten verfügbar.')), photoBox),
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

// ---------- Einmaliger Hinweis zur Nutzung (Urheberrecht) ----------

function usageCard() {
  let ok = false;
  try { ok = localStorage.getItem('ob.legalOk') === '1'; } catch (e) { /* */ }
  if (ok) return null;
  const card = h('div', { class: 'card notice' },
    h('strong', {}, 'Bitte beachten'),
    h('p', { class: 'small' }, 'Lesepixel ist für eigene Dokumente und Notizen, gemeinfreie oder vergriffene Bücher und einzelne Auszüge gedacht. Ein aktuelles Buch vollständig zu digitalisieren, ist in Deutschland auch privat grundsätzlich nicht erlaubt – selbst wenn es dir gehört.'),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn small primary', onClick: () => { try { localStorage.setItem('ob.legalOk', '1'); } catch (e) { /* */ } card.remove(); } }, 'Verstanden'),
      h('a', { class: 'btn small', href: '#/rechtliches' }, 'Mehr erfahren'),
    ),
  );
  return card;
}

// ---------- App-Sperre (Einstellungen) ----------

async function lockCard() {
  const card = h('div', { class: 'card' });
  const bio = await lock.biometricsAvailable();
  const render = () => {
    card.replaceChildren(h('strong', {}, icon('lock'), ' App-Sperre'));
    if (!lock.isConfigured()) {
      card.append(
        h('p', { class: 'muted small' }, 'Lesepixel beim Öffnen mit Face ID / Touch ID oder PIN schützen – sinnvoll bei Unterlagen mit vertraulichen Daten. Einzelne Bücher lassen sich zusätzlich sperren.'),
        h('button', { class: 'btn small', onClick: setupDialog }, icon('lock'), 'App-Sperre einrichten'),
      );
      return;
    }
    const st = lock.settings();
    const delaySel = h('select', { class: 'select', onChange: (e) => lock.setDelay(+e.target.value) },
      ...[[0, 'sofort'], [1, 'nach 1 Minute'], [5, 'nach 5 Minuten'], [15, 'nach 15 Minuten']].map(([v, t]) => h('option', { value: v }, t)));
    delaySel.value = String(st.delay ?? 1);
    card.append(
      h('p', { class: 'muted small' }, (lock.hasBiometrics() ? 'Face ID / Touch ID und PIN' : 'PIN') + ' eingerichtet.' + (st.enabled ? '' : ' Nur gesperrte Bücher sind geschützt.')),
      h('label', { class: 'switch-row small' }, h('span', {}, 'Ganze App beim Öffnen sperren'),
        h('input', { type: 'checkbox', checked: !!st.enabled, onChange: (e) => { const c = lock.settings(); c.enabled = e.target.checked; localStorage.setItem('ob.lock', JSON.stringify(c)); render(); } })),
      st.enabled ? h('label', { class: 'row gap-s small' }, 'Nach Wechsel in den Hintergrund sperren:', delaySel) : null,
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn small', onClick: () => lock.lockNow() }, 'Jetzt sperren'),
        h('button', { class: 'btn small', onClick: async () => {
          if (!(await lock.lockNow('Zum Ausschalten bitte bestätigen.', { needVault: lock.vaultReady() }))) return;
          if (await lock.disable()) { render(); toast('App-Sperre ausgeschaltet'); }
        } }, 'Ausschalten')),
      lock.vaultReady()
        ? h('p', { class: 'muted small' }, icon('lock'), ' Gesperrte Bücher werden auf diesem Gerät verschlüsselt gespeichert (AES-256). ',
          lock.hasBiometrics() && !lock.faceIdOpensVault() ? 'Face ID entsperrt auf diesem Gerät nur die Ansicht – für verschlüsselte Bücher wird die PIN gebraucht.' : lock.hasBiometrics() ? 'Face ID öffnet auch die verschlüsselten Bücher.' : '')
        : h('div', { class: 'stack-s' }, h('p', { class: 'muted small' }, 'Neu: Gesperrte Bücher können verschlüsselt gespeichert werden. Dazu einmal mit der PIN entsperren.'),
          h('button', { class: 'btn small', onClick: async () => { if (await lock.unlockVault('Bitte PIN eingeben, um die Verschlüsselung einzurichten.')) { render(); toast('Verschlüsselung eingerichtet'); } } }, icon('lock'), 'Verschlüsselung einrichten')),
      h('p', { class: 'muted small' }, 'Die Sperre der ganzen App schützt vor neugierigen Blicken; verschlüsselt werden die als „gesperrt“ markierten Bücher.'),
    );
  };
  const setupDialog = () => {
    const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'PIN (mind. 4 Ziffern)' });
    const pin2 = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'PIN wiederholen' });
    const useBio = h('input', { type: 'checkbox', checked: bio, disabled: !bio });
    const whole = h('input', { type: 'checkbox', checked: true });
    const msg = h('p', { class: 'muted small' });
    const s = sheet('App-Sperre einrichten', h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      if (!/^\d{4,}$/.test(pin.value)) { msg.textContent = 'Bitte mindestens 4 Ziffern.'; return; }
      if (pin.value !== pin2.value) { msg.textContent = 'Die PINs stimmen nicht überein.'; return; }
      try {
        await lock.setup({ pin: pin.value, biometrics: useBio.checked, delay: 1 });
        if (!whole.checked) { const c = lock.settings(); c.enabled = false; localStorage.setItem('ob.lock', JSON.stringify(c)); }
        s.close(); render(); toast('App-Sperre eingerichtet');
      } catch (err) {
        msg.textContent = 'Face ID konnte nicht eingerichtet werden (' + (err.name || err.message) + '). Du kannst die Sperre auch nur mit PIN nutzen.';
        useBio.checked = false;
      }
    } },
      h('p', { class: 'muted small' }, 'Die PIN brauchst du, falls Face ID einmal nicht klappt.'),
      pin, pin2,
      h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Face ID / Touch ID verwenden'), h('br'), h('span', { class: 'muted small' }, bio ? 'Wird gleich einmal abgefragt.' : 'Auf diesem Gerät nicht verfügbar.')), useBio),
      h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, 'Ganze App sperren'), h('br'), h('span', { class: 'muted small' }, 'Sonst nur Bücher, die du als „gesperrt“ markierst.')), whole),
      msg,
      h('button', { class: 'btn primary block', type: 'submit' }, 'Einrichten'),
    ));
    setTimeout(() => pin.focus(), 250);
  };
  render();
  return card;
}
