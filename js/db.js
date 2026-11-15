// Lokale Datenbank (IndexedDB). Alles bleibt auf dem Gerät.
// Stores:
//   books: { id, title, author, cover (Blob|null), pageOrder: [pageId], position, bookmarks, createdAt, updatedAt, lastOpenedAt }
//   pages: { id, bookId, image (Blob), thumb (Blob), text (string|null), ocrStatus, confidence, createdAt }

const DB_NAME = 'openbook';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('bookId', 'bookId');
        pages.createIndex('ocrStatus', 'ocrStatus');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Bücher ----------

export async function getBooks() {
  const db = await open();
  return promisify(db.transaction('books').objectStore('books').getAll());
}

export async function getBook(id) {
  const db = await open();
  return promisify(db.transaction('books').objectStore('books').get(id));
}

export async function putBook(book) {
  book.updatedAt = Date.now();
  await tx(['books'], 'readwrite', (t) => t.objectStore('books').put(book));
  emit('book', book.id);
  return book;
}

export async function createBook({ title, author, cover }) {
  const now = Date.now();
  const book = {
    id: uid(),
    title: title || 'Unbenanntes Buch',
    author: author || '',
    cover: cover || null,
    pageOrder: [],
    position: null,
    bookmarks: [],
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: 0,
  };
  await putBook(book);
  return book;
}

export async function deleteBook(id) {
  await tx(['books', 'pages'], 'readwrite', async (t) => {
    t.objectStore('books').delete(id);
    const idx = t.objectStore('pages').index('bookId');
    const keys = await promisify(idx.getAllKeys(id));
    for (const k of keys) t.objectStore('pages').delete(k);
  });
  emit('book', id);
}

// Nur Teilfelder aktualisieren, ohne andere gleichzeitige Änderungen zu überschreiben.
export async function updateBook(id, patch) {
  let updated = null;
  await tx(['books'], 'readwrite', async (t) => {
    const store = t.objectStore('books');
    const book = await promisify(store.get(id));
    if (!book) return;
    const p = typeof patch === 'function' ? patch(book) : patch;
    Object.assign(book, p, { updatedAt: Date.now() });
    store.put(book);
    updated = book;
  });
  if (updated) emit('book', id);
  return updated;
}

// ---------- Seiten ----------

export async function getPage(id) {
  const db = await open();
  return promisify(db.transaction('pages').objectStore('pages').get(id));
}

export async function getPagesMeta(bookId) {
  // Alle Seiten eines Buchs, sortiert nach pageOrder
  const db = await open();
  const [book, pages] = await Promise.all([
    getBook(bookId),
    promisify(db.transaction('pages').objectStore('pages').index('bookId').getAll(bookId)),
  ]);
  if (!book) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ordered = book.pageOrder.map((id) => byId.get(id)).filter(Boolean);
  // Waisen (sollte nicht passieren) hinten anhängen
  for (const p of pages) if (!book.pageOrder.includes(p.id)) ordered.push(p);
  return ordered;
}

export async function addPage(bookId, { image, thumb }, atIndex = null) {
  const page = {
    id: uid(),
    bookId,
    image,
    thumb,
    text: null,
    ocrStatus: 'pending',
    confidence: null,
    createdAt: Date.now(),
  };
  await tx(['books', 'pages'], 'readwrite', async (t) => {
    t.objectStore('pages').put(page);
    const store = t.objectStore('books');
    const book = await promisify(store.get(bookId));
    if (atIndex == null || atIndex >= book.pageOrder.length) book.pageOrder.push(page.id);
    else book.pageOrder.splice(Math.max(0, atIndex), 0, page.id);
    book.updatedAt = Date.now();
    store.put(book);
  });
  emit('pages', bookId);
  return page;
}

export async function putPage(page) {
  await tx(['pages'], 'readwrite', (t) => t.objectStore('pages').put(page));
  emit('page', page.id, page.bookId);
  return page;
}

export async function updatePage(id, patch) {
  let updated = null;
  await tx(['pages'], 'readwrite', async (t) => {
    const store = t.objectStore('pages');
    const page = await promisify(store.get(id));
    if (!page) return;
    Object.assign(page, patch);
    store.put(page);
    updated = page;
  });
  if (updated) emit('page', id, updated.bookId);
  return updated;
}

export async function deletePage(id) {
  let bookId = null;
  await tx(['books', 'pages'], 'readwrite', async (t) => {
    const page = await promisify(t.objectStore('pages').get(id));
    if (!page) return;
    bookId = page.bookId;
    t.objectStore('pages').delete(id);
    const store = t.objectStore('books');
    const book = await promisify(store.get(page.bookId));
    if (book) {
      book.pageOrder = book.pageOrder.filter((p) => p !== id);
      if (book.position && book.position.pageId === id) book.position = null;
      book.bookmarks = (book.bookmarks || []).filter((b) => b.pageId !== id);
      store.put(book);
    }
  });
  if (bookId) emit('pages', bookId);
}

export async function getPagesByStatus(status) {
  const db = await open();
  return promisify(db.transaction('pages').objectStore('pages').index('ocrStatus').getAllKeys(status));
}

// ---------- Änderungs-Events ----------

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(type, id, bookId) {
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
