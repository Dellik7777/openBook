// Lokale Datenbank (IndexedDB). Alles bleibt auf dem Gerät; die Synchronisierung
// (js/sync/) gleicht nur Texte, Profile und Lesestände mit der Cloud ab.
//
// Stores:
//   books:    { id, title, author, cover (Blob|null), coverId, pageOrder: [pageId],
//               createdAt, updatedAt, metaAt (Titel/Autor/Cover), orderAt (Seitenfolge) }
//   pages:    { id, bookId, image (Blob|null), thumb (Blob|null), text, ocrStatus,
//               confidence, createdAt, updatedAt }
//             image ist null, wenn die Seite per Sync von einem anderen Gerät kam.
//   profiles: { id, name, color, settings, createdAt, updatedAt }
//   states:   { key: "profileId|bookId", profileId, bookId, position, bookmarks, lastOpenedAt, updatedAt }
//   figures:  { id, bookId, pageId, image (Blob), rect {x,y,w,h} (relativ zur Seite), w, h,
//               caption, fullPage, createdAt, updatedAt }  (Abbildungen, Karten, Diagramme)
//   folders:  { id, name, parentId, createdAt, updatedAt }
//   meta:     { key, value }  (Sync-Status, Löschmarkierungen)
//
// Bücher haben zusätzlich: folderId (null = Bibliothek), tags: [string], locked (Sperre)
//
// Seiten haben zusätzlich: printedNo (gedruckte Seitenzahl), printedNoManual, paraY (Lage der Absätze)
//
// Verschlüsselung (gesperrte Bücher, siehe vault.js): Bücher mit enc=true speichern Texte, Fotos,
// Abbildungen, Markierungen und Lesezeichen nur verschlüsselt (Felder sx/simg/sthumb, Datensatz enc=1).
// Die Lesefunktionen hier entschlüsseln automatisch, solange der Tresor offen ist; sonst liefern sie
// die Datensätze ohne Inhalt mit sealed=true. Schreiben in ein verschlüsseltes Buch braucht den offenen Tresor.

import * as vault from './vault.js';

const DB_NAME = 'openbook';
const DB_VERSION = 4;
let dbPromise = null;

// Profilfarben (weiße Schrift darauf gut lesbar); zuerst die Markenfarben Navy und Orange-dunkel
export const PROFILE_COLORS = ['#293244', '#A85508', '#5E687C', '#1D4E89', '#2D6A4F', '#7B2D8B', '#B8336A', '#0F766E'];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const t = req.transaction;
      const old = e.oldVersion;
      if (old < 1) {
        db.createObjectStore('books', { keyPath: 'id' });
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('bookId', 'bookId');
        pages.createIndex('ocrStatus', 'ocrStatus');
      }
      if (old < 2) {
        db.createObjectStore('profiles', { keyPath: 'id' });
        const states = db.createObjectStore('states', { keyPath: 'key' });
        states.createIndex('bookId', 'bookId');
        states.createIndex('profileId', 'profileId');
        db.createObjectStore('meta', { keyPath: 'key' });
        if (old >= 1) migrateV1(t);
      }
      if (old < 3) {
        const figs = db.createObjectStore('figures', { keyPath: 'id' });
        figs.createIndex('bookId', 'bookId');
        figs.createIndex('pageId', 'pageId');
      }
      if (old < 4) {
        // Ordner: { id, name, parentId (null = oberste Ebene), createdAt, updatedAt }
        db.createObjectStore('folders', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Version 1 hatte Leseposition & Lesezeichen direkt am Buch → in ein Standardprofil umziehen
function migrateV1(t) {
  const now = Date.now();
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem('ob.reader') || '{}'); } catch (e) { /* ignorieren */ }
  const profile = { id: uid(), name: 'Ich', color: PROFILE_COLORS[0], settings, createdAt: now, updatedAt: now };
  t.objectStore('profiles').put(profile);
  try { localStorage.setItem('ob.profile', profile.id); } catch (e) { /* ignorieren */ }
  t.objectStore('books').openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    const b = cur.value;
    if (b.position || (b.bookmarks && b.bookmarks.length) || b.lastOpenedAt) {
      t.objectStore('states').put({
        key: profile.id + '|' + b.id, profileId: profile.id, bookId: b.id,
        position: b.position || null, bookmarks: b.bookmarks || [], lastOpenedAt: b.lastOpenedAt || 0, updatedAt: now,
      });
    }
    delete b.position; delete b.bookmarks; delete b.lastOpenedAt;
    b.metaAt = b.metaAt || b.updatedAt || b.createdAt;
    b.orderAt = b.orderAt || b.updatedAt || b.createdAt;
    b.coverId = b.cover ? uid() : null;
    cur.update(b);
    cur.continue();
  };
  t.objectStore('pages').openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    const p = cur.value;
    if (!p.updatedAt) { p.updatedAt = p.createdAt || now; cur.update(p); }
    cur.continue();
  };
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function getAll(store, index, key) {
  const db = await open();
  const s = db.transaction(store).objectStore(store);
  return promisify(index ? s.index(index).getAll(key) : s.getAll());
}

async function getOne(store, key) {
  const db = await open();
  return promisify(db.transaction(store).objectStore(store).get(key));
}

// ---------- Verschlüsselung gesperrter Bücher ----------

const encCache = new Map(); // bookId → enc
async function isEncBook(bookId) {
  if (!bookId) return false;
  if (!encCache.has(bookId)) { const b = await getOne('books', bookId); encCache.set(bookId, !!(b && b.enc)); }
  return encCache.get(bookId);
}
const SECRET = {
  pages: ['text', 'lines', 'uncertain'],
  figures: ['caption'],
  states: ['highlights', 'bookmarks'],
};
const BLOBS = { pages: ['image', 'thumb', 'orig'], figures: ['image'], states: [] };
const EMPTY = { text: null, lines: null, uncertain: null, caption: '', highlights: [], bookmarks: [], image: null, thumb: null, orig: null };
const BLOB_FIELD = { image: 'simg', thumb: 'sthumb', orig: 'sorig' };
const HAS = { image: 'hasImage', orig: 'hasOrig' };
const LAZY = new Set(['image', 'orig']); // große Bilder: mit images:false nicht entschlüsseln

// Klartext-Datensatz → gespeicherte Form (verschlüsselt, wenn das Buch verschlüsselt ist)
async function seal(kind, rec, existing = null) {
  if (!rec || rec.enc || !(await isEncBook(rec.bookId))) {
    if (rec && !rec.enc && (rec.sealed || rec.hasImage !== undefined || rec.hasOrig !== undefined)) { const r = { ...rec }; delete r.sealed; delete r.hasImage; delete r.hasOrig; return r; }
    return rec;
  }
  if (!vault.isOpen()) throw new vault.LockedError();
  const out = { ...rec, enc: 1 };
  delete out.sealed; delete out.hasImage; delete out.hasOrig;
  const secret = {};
  for (const k of SECRET[kind]) { secret[k] = rec[k] ?? EMPTY[k]; out[k] = EMPTY[k]; }
  out.sx = await vault.sealJson(secret);
  for (const k of BLOBS[kind]) {
    const f = BLOB_FIELD[k];
    if (rec[k]) out[f] = await vault.sealBlob(rec[k]);
    else if (HAS[k] && rec[HAS[k]] && existing && existing[f]) out[f] = existing[f]; // ohne Bild geladen → altes behalten
    else out[f] = null;
    out[k] = null;
  }
  return out;
}

// Gespeicherte Form → Klartext (images=false: Seitenfoto nicht entschlüsseln, nur hasImage)
async function unseal(kind, rec, { images = true, raw = false } = {}) {
  if (!rec || !rec.enc || raw) return rec;
  const out = { ...rec };
  delete out.enc; delete out.sx;
  for (const f of Object.values(BLOB_FIELD)) delete out[f];
  // hasImage nur, wenn das Foto nicht mitgeladen wird (dann bleibt es beim Zurückschreiben erhalten)
  if (kind === 'pages' && (!images || !vault.isOpen())) { out.hasImage = !!rec.simg; out.hasOrig = !!rec.sorig; }
  if (!vault.isOpen()) { out.sealed = true; return out; }
  try {
    Object.assign(out, await vault.openJson(rec.sx));
    for (const k of BLOBS[kind]) {
      const f = BLOB_FIELD[k];
      out[k] = rec[f] && (images || !LAZY.has(k) || kind !== 'pages') ? await vault.openBlob(rec[f]) : null;
    }
  } catch (e) {
    console.warn('Entschlüsseln fehlgeschlagen', e);
    out.sealed = true;
  }
  return out;
}
const unsealAll = (kind, list, opts) => Promise.all(list.map((r) => unseal(kind, r, opts)));

export const isSealed = (rec) => !!(rec && rec.sealed);

// Seitenfoto bei Bedarf laden (Seiten, die ohne Foto geladen wurden)
export async function pageImage(page) {
  if (!page) return null;
  if (page.image) return page.image;
  if (!page.hasImage) return null;
  const rec = await unseal('pages', await getOne('pages', page.id));
  return rec ? rec.image : null;
}

// Buch ver- oder entschlüsseln (alle Seiten, Abbildungen, Lesestände). Braucht den offenen Tresor.
export async function setBookEncrypted(bookId, on, onProgress) {
  const book = await getOne('books', bookId);
  if (!book || !!book.enc === !!on) return;
  if (!vault.isOpen()) throw new vault.LockedError();
  if (on) { book.enc = true; await tx(['books'], 'readwrite', (t) => t.objectStore('books').put(book)); encCache.set(bookId, true); }
  else encCache.set(bookId, false);
  const pages = await getAll('pages', 'bookId', bookId);
  let n = 0;
  for (const raw of pages) {
    const next = on ? await seal('pages', raw) : await unseal('pages', raw);
    if (next !== raw) { delete next.hasImage; delete next.sealed; await tx(['pages'], 'readwrite', (t) => t.objectStore('pages').put(next)); }
    onProgress && onProgress(++n / pages.length);
  }
  for (const raw of await getAll('figures', 'bookId', bookId)) {
    const next = on ? await seal('figures', raw) : await unseal('figures', raw);
    if (next !== raw) { delete next.sealed; await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(next)); }
  }
  for (const raw of await getAll('states', 'bookId', bookId)) {
    const next = on ? await seal('states', raw) : await unseal('states', raw);
    if (next !== raw) { delete next.sealed; await tx(['states'], 'readwrite', (t) => t.objectStore('states').put(next)); }
  }
  if (!on) { const b = await getOne('books', bookId); delete b.enc; await tx(['books'], 'readwrite', (t) => t.objectStore('books').put(b)); }
  emit('book', bookId);
}

// ---------- Löschmarkierungen (damit Löschen auch auf anderen Geräten ankommt) ----------

const TOMB_KINDS = ['books', 'pages', 'profiles', 'figures', 'folders'];
const emptyTombs = () => ({ books: {}, pages: {}, profiles: {}, figures: {}, folders: {} });

async function addTombstone(t, kind, id, extra = {}) {
  const store = t.objectStore('meta');
  const rec = (await promisify(store.get('tombstones'))) || { key: 'tombstones', value: emptyTombs() };
  rec.value[kind] = rec.value[kind] || {};
  rec.value[kind][id] = { at: Date.now(), ...extra };
  store.put(rec);
}

export async function getTombstones() {
  const rec = await getOne('meta', 'tombstones');
  return { ...emptyTombs(), ...(rec ? rec.value : {}) };
}

export async function mergeTombstones(remote) {
  await tx(['meta'], 'readwrite', async (t) => {
    const store = t.objectStore('meta');
    const rec = (await promisify(store.get('tombstones'))) || { key: 'tombstones', value: emptyTombs() };
    for (const kind of TOMB_KINDS) {
      rec.value[kind] = rec.value[kind] || {};
      for (const [id, v] of Object.entries((remote && remote[kind]) || {})) {
        const cur = rec.value[kind][id];
        if (!cur || cur.at < v.at) rec.value[kind][id] = v;
      }
    }
    store.put(rec);
  });
}

// ---------- Meta ----------

export async function getMeta(key, fallback = null) {
  const rec = await getOne('meta', key);
  return rec ? rec.value : fallback;
}

export async function setMeta(key, value) {
  await tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put({ key, value }));
}

// ---------- Bücher ----------

export const getBooks = () => getAll('books');
export const getBook = (id) => getOne('books', id);

// Unverändert speichern (für Sync & Import)
export async function putBookRaw(book, { silent = false } = {}) {
  encCache.set(book.id, !!book.enc);
  await tx(['books'], 'readwrite', (t) => t.objectStore('books').put(book));
  if (!silent) emit('book', book.id);
  return book;
}

export async function createBook({ title, author, cover }) {
  const now = Date.now();
  const book = {
    id: uid(),
    title: title || 'Unbenanntes Buch',
    author: author || '',
    cover: cover || null,
    coverId: cover ? uid() : null,
    pageOrder: [],
    createdAt: now,
    updatedAt: now,
    metaAt: now,
    orderAt: now,
  };
  await putBookRaw(book);
  return book;
}

export async function deleteBook(id) {
  encCache.delete(id);
  await tx(['books', 'pages', 'states', 'meta', 'figures'], 'readwrite', async (t) => {
    t.objectStore('books').delete(id);
    const figKeys = await promisify(t.objectStore('figures').index('bookId').getAllKeys(id));
    for (const k of figKeys) t.objectStore('figures').delete(k);
    const pageKeys = await promisify(t.objectStore('pages').index('bookId').getAllKeys(id));
    for (const k of pageKeys) t.objectStore('pages').delete(k);
    const stateKeys = await promisify(t.objectStore('states').index('bookId').getAllKeys(id));
    for (const k of stateKeys) t.objectStore('states').delete(k);
    await addTombstone(t, 'books', id);
  });
  emit('book', id);
}

// Löschen ohne Löschmarkierung (wenn das Löschen von einem anderen Gerät kommt)
export async function purgeBook(id) {
  await tx(['books', 'pages', 'states', 'figures'], 'readwrite', async (t) => {
    t.objectStore('books').delete(id);
    const figKeys = await promisify(t.objectStore('figures').index('bookId').getAllKeys(id));
    for (const k of figKeys) t.objectStore('figures').delete(k);
    const pageKeys = await promisify(t.objectStore('pages').index('bookId').getAllKeys(id));
    for (const k of pageKeys) t.objectStore('pages').delete(k);
    const stateKeys = await promisify(t.objectStore('states').index('bookId').getAllKeys(id));
    for (const k of stateKeys) t.objectStore('states').delete(k);
  });
  emit('book', id);
}

// Teilfelder aktualisieren; Zeitstempel für die Synchronisierung werden mitgeführt.
export async function updateBook(id, patch) {
  let updated = null;
  await tx(['books'], 'readwrite', async (t) => {
    const store = t.objectStore('books');
    const book = await promisify(store.get(id));
    if (!book) return;
    const p = typeof patch === 'function' ? patch(book) : patch;
    if (!p || !Object.keys(p).length) { updated = book; return; }
    const now = Date.now();
    if (['title', 'author', 'cover', 'ignoredGaps', 'folderId', 'tags', 'locked', 'isbn', 'source'].some((k) => k in p)) book.metaAt = now;
    if ('cover' in p && p.cover !== book.cover) book.coverId = p.cover ? uid() : null;
    if ('pageOrder' in p) book.orderAt = now;
    Object.assign(book, p, { updatedAt: now });
    store.put(book);
    updated = book;
  });
  if (updated) emit('book', id);
  return updated;
}

// ---------- Seiten ----------

export const getPage = async (id, opts) => unseal('pages', await getOne('pages', id), opts);
// opts: { images: false } → Seitenfotos verschlüsselter Bücher nicht entschlüsseln (hasImage), { raw: true } → wie gespeichert
export const getPagesOfBook = async (bookId, opts) => unsealAll('pages', await getAll('pages', 'bookId', bookId), opts);

export async function getPagesMeta(bookId, opts) {
  // Alle Seiten eines Buchs, sortiert nach pageOrder
  const [book, pages] = await Promise.all([getBook(bookId), getPagesOfBook(bookId, opts)]);
  if (!book) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ordered = book.pageOrder.map((id) => byId.get(id)).filter(Boolean);
  const inOrder = new Set(book.pageOrder);
  for (const p of pages) if (!inOrder.has(p.id)) ordered.push(p);
  return ordered;
}

// extra: weitere Felder, z. B. für importierte Seiten mit fertigem Text (text, ocrStatus: 'done', paraY …)
export async function addPage(bookId, { image, thumb, ...extra }, atIndex = null) {
  const now = Date.now();
  const page = {
    id: uid(),
    bookId,
    image: image || null,
    thumb: thumb || null,
    text: null,
    ocrStatus: 'pending',
    confidence: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  const rec = await seal('pages', page);
  await tx(['books', 'pages'], 'readwrite', async (t) => {
    t.objectStore('pages').put(rec);
    const store = t.objectStore('books');
    const book = await promisify(store.get(bookId));
    if (atIndex == null || atIndex >= book.pageOrder.length) book.pageOrder.push(page.id);
    else book.pageOrder.splice(Math.max(0, atIndex), 0, page.id);
    book.updatedAt = book.orderAt = now;
    store.put(book);
  });
  emit('pages', bookId);
  return page;
}

export async function putPage(page, { silent = false } = {}) {
  const existing = (page.hasImage && !page.image) || (page.hasOrig && !page.orig) ? await getOne('pages', page.id) : null;
  const rec = await seal('pages', page, existing);
  await tx(['pages'], 'readwrite', (t) => t.objectStore('pages').put(rec));
  if (!silent) emit('page', page.id, page.bookId);
  return page;
}

const SYNCED_PAGE_FIELDS = ['text', 'ocrStatus', 'confidence', 'printedNo', 'printedNoManual', 'paraY'];

export async function updatePage(id, patch) {
  const raw0 = await getOne('pages', id);
  if (raw0 && (raw0.enc || await isEncBook(raw0.bookId))) {
    // Verschlüsselt: lesen, ändern, neu verschlüsseln (Kryptografie geht nicht innerhalb einer Transaktion)
    const page = await unseal('pages', raw0);
    if (page.sealed) throw new vault.LockedError();
    if (SYNCED_PAGE_FIELDS.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(page[k]))) page.updatedAt = Date.now();
    if ('image' in patch && patch.image !== page.image) page.imageAt = Date.now();
    Object.assign(page, patch);
    const rec = await seal('pages', page);
    await tx(['pages'], 'readwrite', (t) => t.objectStore('pages').put(rec));
    emit('page', id, page.bookId);
    return page;
  }
  let updated = null;
  await tx(['pages'], 'readwrite', async (t) => {
    const store = t.objectStore('pages');
    const page = await promisify(store.get(id));
    if (!page) return;
    if (SYNCED_PAGE_FIELDS.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(page[k]))) page.updatedAt = Date.now();
    if ('image' in patch && patch.image !== page.image) page.imageAt = Date.now(); // für die Foto-Sicherung
    Object.assign(page, patch);
    store.put(page);
    updated = page;
  });
  if (updated) emit('page', id, updated.bookId);
  return updated;
}

export async function deletePage(id) {
  let bookId = null;
  await tx(['books', 'pages', 'states', 'meta', 'figures'], 'readwrite', async (t) => {
    const page = await promisify(t.objectStore('pages').get(id));
    if (!page) return;
    bookId = page.bookId;
    t.objectStore('pages').delete(id);
    for (const f of await promisify(t.objectStore('figures').index('pageId').getAll(id))) {
      t.objectStore('figures').delete(f.id);
      await addTombstone(t, 'figures', f.id, { bookId: page.bookId });
    }
    const store = t.objectStore('books');
    const book = await promisify(store.get(page.bookId));
    if (book) {
      book.pageOrder = book.pageOrder.filter((p) => p !== id);
      book.updatedAt = book.orderAt = Date.now();
      store.put(book);
    }
    // Lesestände, die auf diese Seite zeigen, bereinigen
    const states = await promisify(t.objectStore('states').index('bookId').getAll(page.bookId));
    for (const s of states) {
      let changed = false;
      if (s.position && s.position.pageId === id) { s.position = { ratio: s.position.ratio || 0 }; changed = true; }
      const bms = (s.bookmarks || []).filter((b) => b.pageId !== id);
      if (bms.length !== (s.bookmarks || []).length) { s.bookmarks = bms; changed = true; }
      if (changed) { s.updatedAt = Date.now(); t.objectStore('states').put(s); }
    }
    await addTombstone(t, 'pages', id, { bookId: page.bookId });
  });
  if (bookId) emit('pages', bookId);
}

export async function deletePageRaw(id) {
  await tx(['pages', 'figures'], 'readwrite', async (t) => {
    t.objectStore('pages').delete(id);
    const keys = await promisify(t.objectStore('figures').index('pageId').getAllKeys(id));
    for (const k of keys) t.objectStore('figures').delete(k);
  });
}

// ---------- Ordner ----------

export const getFolders = () => getAll('folders');
export const getFolder = (id) => getOne('folders', id);

export async function putFolder(folder, { raw = false, silent = false } = {}) {
  if (!raw) folder.updatedAt = Date.now();
  await tx(['folders'], 'readwrite', (t) => t.objectStore('folders').put(folder));
  if (!silent) emit('folder', folder.id);
  return folder;
}

export async function createFolder(name, parentId = null) {
  const now = Date.now();
  return putFolder({ id: uid(), name: name || 'Neuer Ordner', parentId: parentId || null, createdAt: now, updatedAt: now });
}

// Löschen: Bücher und Unterordner wandern eine Ebene nach oben
export async function deleteFolder(id, { tombstone = true } = {}) {
  const folder = await getFolder(id);
  if (!folder) return;
  const parent = folder.parentId || null;
  for (const f of await getFolders()) if (f.parentId === id) await putFolder({ ...f, parentId: parent });
  for (const b of await getBooks()) if (b.folderId === id) await updateBook(b.id, { folderId: parent });
  await tx(['folders', 'meta'], 'readwrite', async (t) => {
    t.objectStore('folders').delete(id);
    if (tombstone) await addTombstone(t, 'folders', id);
  });
  emit('folder', id);
}

export async function deleteFolderRaw(id) {
  await tx(['folders'], 'readwrite', (t) => t.objectStore('folders').delete(id));
}

// ---------- Abbildungen ----------

export const getFigure = async (id) => unseal('figures', await getOne('figures', id));
export const getFiguresOfBook = async (bookId, opts) => unsealAll('figures', await getAll('figures', 'bookId', bookId), opts);
export const getFiguresOfPage = async (pageId) => unsealAll('figures', await getAll('figures', 'pageId', pageId));

export async function addFigure({ bookId, pageId, image, rect, w, h, caption = '', fullPage = false }) {
  const now = Date.now();
  const fig = { id: uid(), bookId, pageId, image, rect, w, h, caption, fullPage, createdAt: now, updatedAt: now };
  const rec = await seal('figures', fig);
  await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(rec));
  emit('figure', fig.id, bookId);
  return fig;
}

export async function updateFigure(id, patch) {
  const raw = await getOne('figures', id);
  if (!raw) return null;
  const f = await unseal('figures', raw);
  if (f.sealed) throw new vault.LockedError();
  Object.assign(f, patch, { updatedAt: Date.now() });
  const rec = await seal('figures', f);
  await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(rec));
  const updated = f;
  if (updated) emit('figure', id, updated.bookId);
  return updated;
}

export async function putFigureRaw(fig, { silent = false } = {}) {
  const rec = await seal('figures', fig);
  await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(rec));
  if (!silent) emit('figure', fig.id, fig.bookId);
}

export async function deleteFigure(id, { tombstone = true } = {}) {
  let bookId = null;
  await tx(['figures', 'meta'], 'readwrite', async (t) => {
    const f = await promisify(t.objectStore('figures').get(id));
    if (!f) return;
    bookId = f.bookId;
    t.objectStore('figures').delete(id);
    if (tombstone) await addTombstone(t, 'figures', id, { bookId });
  });
  if (bookId) emit('figure', id, bookId);
}

export async function getPagesByStatus(status) {
  const db = await open();
  return promisify(db.transaction('pages').objectStore('pages').index('ocrStatus').getAllKeys(status));
}

// ---------- Profile ----------

export const getProfiles = () => getAll('profiles');
export const getProfile = (id) => getOne('profiles', id);

export async function putProfile(profile, { raw = false, silent = false } = {}) {
  if (!raw) profile.updatedAt = Date.now();
  await tx(['profiles'], 'readwrite', (t) => t.objectStore('profiles').put(profile));
  if (!silent) emit('profile', profile.id);
  return profile;
}

export async function createProfile(name, color) {
  const now = Date.now();
  return putProfile({ id: uid(), name: name || 'Profil', color: color || PROFILE_COLORS[0], settings: {}, createdAt: now, updatedAt: now });
}

export async function deleteProfile(id, { tombstone = true } = {}) {
  await tx(['profiles', 'states', 'meta'], 'readwrite', async (t) => {
    t.objectStore('profiles').delete(id);
    const keys = await promisify(t.objectStore('states').index('profileId').getAllKeys(id));
    for (const k of keys) t.objectStore('states').delete(k);
    if (tombstone) await addTombstone(t, 'profiles', id);
  });
  emit('profile', id);
}

// ---------- Lesestände (je Profil und Buch) ----------

export const stateKey = (profileId, bookId) => profileId + '|' + bookId;
export const getState = async (profileId, bookId) => unseal('states', await getOne('states', stateKey(profileId, bookId)));
export const getStatesOfProfile = async (profileId, opts) => unsealAll('states', await getAll('states', 'profileId', profileId), opts);
export const getAllStates = async (opts) => unsealAll('states', await getAll('states'), opts);

// touch=false: Änderung zählt nicht als neuer Lesestand (z. B. nur „zuletzt geöffnet“)
export async function updateState(profileId, bookId, patch, { touch = true } = {}) {
  if (await isEncBook(bookId)) {
    const key = stateKey(profileId, bookId);
    const raw = await getOne('states', key);
    // Ohne offenen Tresor nur unverschlüsselte Felder (Position, zuletzt geöffnet, Status) ändern
    const p0 = typeof patch === 'function' ? null : patch;
    const onlyPlain = p0 && Object.keys(p0).every((k) => !SECRET.states.includes(k));
    if (raw && raw.enc && !vault.isOpen()) {
      if (!onlyPlain) throw new vault.LockedError();
      Object.assign(raw, p0);
      if (touch) raw.updatedAt = Date.now();
      await tx(['states'], 'readwrite', (t) => t.objectStore('states').put(raw));
      emit('state', key, bookId);
      return unseal('states', raw);
    }
    const s = raw ? await unseal('states', raw) : { key, profileId, bookId, position: null, bookmarks: [], lastOpenedAt: 0, updatedAt: 0 };
    Object.assign(s, typeof patch === 'function' ? patch(s) : patch);
    if (touch) s.updatedAt = Date.now();
    const rec = await seal('states', s);
    await tx(['states'], 'readwrite', (t) => t.objectStore('states').put(rec));
    emit('state', key, bookId);
    return s;
  }
  let updated = null;
  await tx(['states'], 'readwrite', async (t) => {
    const store = t.objectStore('states');
    const key = stateKey(profileId, bookId);
    const s = (await promisify(store.get(key))) || { key, profileId, bookId, position: null, bookmarks: [], lastOpenedAt: 0, updatedAt: 0 };
    Object.assign(s, typeof patch === 'function' ? patch(s) : patch);
    if (touch) s.updatedAt = Date.now();
    store.put(s);
    updated = s;
  });
  emit('state', updated.key, bookId);
  return updated;
}

export async function putStateRaw(state, { silent = false } = {}) {
  const rec = await seal('states', state);
  await tx(['states'], 'readwrite', (t) => t.objectStore('states').put(rec));
  if (!silent) emit('state', state.key, state.bookId);
}

// ---------- Änderungs-Events ----------

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(type, id, bookId) {
  for (const fn of listeners) {
    try { fn({ type, id, bookId: bookId || id }); } catch (e) { console.error(e); }
  }
}

// ---------- Speicher ----------

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) return await navigator.storage.persist();
      return true;
    }
  } catch (e) { /* ignorieren */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) { /* ignorieren */ }
  return null;
}
