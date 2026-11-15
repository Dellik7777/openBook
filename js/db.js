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
//   meta:     { key, value }  (Sync-Status, Löschmarkierungen)
//
// Seiten haben zusätzlich: printedNo (gedruckte Seitenzahl), printedNoManual, paraY (Lage der Absätze)

const DB_NAME = 'openbook';
const DB_VERSION = 3;
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

// ---------- Löschmarkierungen (damit Löschen auch auf anderen Geräten ankommt) ----------

const TOMB_KINDS = ['books', 'pages', 'profiles', 'figures'];
const emptyTombs = () => ({ books: {}, pages: {}, profiles: {}, figures: {} });

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
    if ('title' in p || 'author' in p || 'cover' in p || 'ignoredGaps' in p) book.metaAt = now;
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

export const getPage = (id) => getOne('pages', id);
export const getPagesOfBook = (bookId) => getAll('pages', 'bookId', bookId);

export async function getPagesMeta(bookId) {
  // Alle Seiten eines Buchs, sortiert nach pageOrder
  const [book, pages] = await Promise.all([getBook(bookId), getPagesOfBook(bookId)]);
  if (!book) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ordered = book.pageOrder.map((id) => byId.get(id)).filter(Boolean);
  const inOrder = new Set(book.pageOrder);
  for (const p of pages) if (!inOrder.has(p.id)) ordered.push(p);
  return ordered;
}

export async function addPage(bookId, { image, thumb }, atIndex = null) {
  const now = Date.now();
  const page = {
    id: uid(),
    bookId,
    image,
    thumb,
    text: null,
    ocrStatus: 'pending',
    confidence: null,
    createdAt: now,
    updatedAt: now,
  };
  await tx(['books', 'pages'], 'readwrite', async (t) => {
    t.objectStore('pages').put(page);
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
  await tx(['pages'], 'readwrite', (t) => t.objectStore('pages').put(page));
  if (!silent) emit('page', page.id, page.bookId);
  return page;
}

const SYNCED_PAGE_FIELDS = ['text', 'ocrStatus', 'confidence', 'printedNo', 'printedNoManual', 'paraY'];

export async function updatePage(id, patch) {
  let updated = null;
  await tx(['pages'], 'readwrite', async (t) => {
    const store = t.objectStore('pages');
    const page = await promisify(store.get(id));
    if (!page) return;
    if (SYNCED_PAGE_FIELDS.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(page[k]))) page.updatedAt = Date.now();
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

// ---------- Abbildungen ----------

export const getFigure = (id) => getOne('figures', id);
export const getFiguresOfBook = (bookId) => getAll('figures', 'bookId', bookId);
export const getFiguresOfPage = (pageId) => getAll('figures', 'pageId', pageId);

export async function addFigure({ bookId, pageId, image, rect, w, h, caption = '', fullPage = false }) {
  const now = Date.now();
  const fig = { id: uid(), bookId, pageId, image, rect, w, h, caption, fullPage, createdAt: now, updatedAt: now };
  await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(fig));
  emit('figure', fig.id, bookId);
  return fig;
}

export async function updateFigure(id, patch) {
  let updated = null;
  await tx(['figures'], 'readwrite', async (t) => {
    const store = t.objectStore('figures');
    const f = await promisify(store.get(id));
    if (!f) return;
    Object.assign(f, patch, { updatedAt: Date.now() });
    store.put(f);
    updated = f;
  });
  if (updated) emit('figure', id, updated.bookId);
  return updated;
}

export async function putFigureRaw(fig, { silent = false } = {}) {
  await tx(['figures'], 'readwrite', (t) => t.objectStore('figures').put(fig));
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
export const getState = (profileId, bookId) => getOne('states', stateKey(profileId, bookId));
export const getStatesOfProfile = (profileId) => getAll('states', 'profileId', profileId);
export const getAllStates = () => getAll('states');

// touch=false: Änderung zählt nicht als neuer Lesestand (z. B. nur „zuletzt geöffnet“)
export async function updateState(profileId, bookId, patch, { touch = true } = {}) {
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
  await tx(['states'], 'readwrite', (t) => t.objectStore('states').put(state));
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
