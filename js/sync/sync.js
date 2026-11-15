// Synchronisierung über den Cloud-Speicher des Nutzers (Google Drive oder OneDrive).
//
// Abgeglichen werden Texte, Titel/Autor/Cover, Profile, Lesestände, Lesestatistik und Lernkarten.
// Seitenfotos nur, wenn „Fotos mitsichern“ eingeschaltet ist (sonst bleiben sie auf dem Gerät).
//
// Dateien im App-Ordner:
//   library.json         Profile, Bücher (Metadaten), Lesestände, Löschmarkierungen
//   book-<id>.json        Seitentexte und Seitenreihenfolge eines Buchs
//   cover-<coverId>.jpg   Cover
//   fig-<id>.jpg          Abbildungen (Karten, Diagramme, Bilder)
//   extras.json           Lesestatistik (je Gerät) und Lernkarten-Stand je Profil
//   imgs-<bookId>.json    Seitenfotos in der Cloud: { pageId: Version }  (nur mit Foto-Sicherung)
//   img-<pageId>.jpg      Seitenfoto
//
// Konfliktregel: Für jeden Datensatz gewinnt die jüngere Änderung (Zeitstempel).

import * as db from '../db.js';
import * as profiles from '../profiles.js';
import { google } from './google.js';
import { onedrive } from './onedrive.js';
import { AuthError, ConflictError, takePending } from './oauth.js';
import * as stats from '../stats.js';
import * as vault from '../vault.js';
import { mergeCards } from '../cards.js';

const PHOTOS_PER_RUN = 40; // Fotos je Durchgang (der Rest folgt im nächsten)
export const photosEnabled = () => { try { return localStorage.getItem('ob.sync.photos') === '1'; } catch (e) { return false; } };
export function setPhotos(on) { try { localStorage.setItem('ob.sync.photos', on ? '1' : '0'); } catch (e) { /* */ } if (on) syncNow(); }

export const PROVIDERS = { google, onedrive };

let provider = null;
let running = null;
let timer = null;
let interval = null;
let applying = false;
let pendingAgain = false;
const listeners = new Set();
let status = { state: 'off', lastSync: 0, message: '' };

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of listeners) try { fn(status); } catch (e) { console.error(e); }
}
export function onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
export function getStatus() { return status; }
export function getProvider() { return provider; }

// ---------- Start, Anmeldung ----------

export async function init() {
  let chosen = null;
  try { chosen = localStorage.getItem('ob.sync.provider'); } catch (e) { /* ignorieren */ }
  const pending = takePending();
  let justLoggedIn = false;
  if (pending && PROVIDERS[pending.provider]) {
    const p = PROVIDERS[pending.provider];
    const isReturn = location.hash.includes('state=') || location.search.includes('state=');
    if (isReturn) {
      try {
        const r = await p.handleRedirect(pending);
        if (r.ok) {
          chosen = p.id;
          localStorage.setItem('ob.sync.provider', p.id);
          justLoggedIn = true;
        } else if (!r.silent) {
          setStatus({ state: 'error', message: 'Anmeldung fehlgeschlagen: ' + r.error });
        } else {
          // Stille Erneuerung ging nicht → beim nächsten Mal sichtbar anmelden
          setStatus({ state: 'auth', message: 'Bitte erneut anmelden' });
          try { localStorage.setItem('ob.sync.noSilent', String(Date.now())); } catch (e) { /* ignorieren */ }
        }
      } catch (e) {
        console.error(e);
        setStatus({ state: 'error', message: 'Anmeldung fehlgeschlagen: ' + e.message });
      }
    }
  }
  provider = chosen && PROVIDERS[chosen] ? PROVIDERS[chosen] : null;
  if (!provider) { setStatus({ state: 'off' }); return; }
  const last = await db.getMeta('sync', {});
  setStatus({ state: status.state === 'off' ? 'idle' : status.state, lastSync: last.lastSync || 0 });

  db.onChange((e) => {
    if (applying || e.type === 'sync') return;
    schedule(e.type === 'state' ? 60_000 : 15_000);
  });
  document.addEventListener('visibilitychange', () => {
    if (!provider) return;
    if (document.visibilityState === 'visible') { if (Date.now() - status.lastSync > 30_000) syncNow(); }
    else if (timer) { clearTimeout(timer); timer = null; syncNow(); }
  });
  window.addEventListener('online', () => syncNow());
  clearInterval(interval);
  interval = setInterval(() => syncNow(), 5 * 60_000);
  syncNow({ interactive: !justLoggedIn });
}

export function connect(id) {
  const p = PROVIDERS[id];
  try { localStorage.setItem('ob.sync.provider', id); localStorage.removeItem('ob.sync.noSilent'); } catch (e) { /* ignorieren */ }
  p.connect({ silent: false });
}

export async function disconnect() {
  if (provider) provider.disconnect();
  provider = null;
  try { localStorage.removeItem('ob.sync.provider'); } catch (e) { /* ignorieren */ }
  await db.setMeta('sync', {});
  clearInterval(interval);
  setStatus({ state: 'off', message: '', lastSync: 0 });
}

function schedule(delay) {
  if (!provider) return;
  if (timer) return; // läuft schon ein Timer, nicht weiter verschieben
  timer = setTimeout(() => { timer = null; syncNow(); }, delay);
}

// interactive: darf für eine abgelaufene Google-Anmeldung kurz zur Anmeldeseite springen
export function syncNow({ interactive = false } = {}) {
  if (!provider) return Promise.resolve(false);
  if (running) { pendingAgain = true; return running; }
  if (!navigator.onLine) { setStatus({ state: 'offline', message: 'Offline' }); return Promise.resolve(false); }
  running = (async () => {
    setStatus({ state: 'syncing', message: '' });
    try {
      await provider.ensureToken();
      for (let attempt = 0; ; attempt++) {
        try {
          await runOnce();
          break;
        } catch (e) {
          if (e instanceof ConflictError && attempt < 3) continue; // anderes Gerät war schneller → neu zusammenführen
          throw e;
        }
      }
      setStatus({ state: 'idle', lastSync: Date.now(), message: '' });
      return true;
    } catch (e) {
      if (e instanceof AuthError) {
        // Google: Token gilt nur 1 h → still erneuern, aber nur beim Öffnen der App / auf Wunsch
        let noSilent = 0;
        try { noSilent = +localStorage.getItem('ob.sync.noSilent') || 0; } catch (err) { /* ignorieren */ }
        if (interactive && provider.id === 'google' && Date.now() - noSilent > 10 * 60_000) {
          provider.connect({ silent: true });
          return false;
        }
        setStatus({ state: 'auth', message: e.message });
      } else {
        console.error('Sync-Fehler', e);
        setStatus({ state: 'error', message: e.message || String(e) });
      }
      return false;
    } finally {
      running = null;
      if (pendingAgain) { pendingAgain = false; schedule(2000); }
    }
  })();
  return running;
}

// ---------- Abgleich ----------

const LIB = 'library.json';
const emptyLib = () => ({ format: 'openbook-sync', version: 1, profiles: {}, books: {}, states: {}, folders: {}, tombstones: { books: {}, pages: {}, profiles: {}, figures: {}, folders: {} } });

async function runOnce() {
  await provider.begin();
  const remote = await provider.read(LIB);
  let lib = emptyLib();
  if (remote) {
    try { lib = { ...emptyLib(), ...JSON.parse(remote.data) }; } catch (e) { throw new Error('library.json in der Cloud ist beschädigt'); }
    if (lib.format !== 'openbook-sync') throw new Error('Unbekanntes Format in der Cloud');
  }
  const syncState = await db.getMeta('sync', {});
  const seen = syncState.seen || {};
  const figsInCloud = syncState.figs || {};
  const imgs = syncState.imgs || {};          // pageId → Version, die in der Cloud liegt
  const imgsV = syncState.imgsV || {};        // bookId → Stand der Foto-Liste
  const seenImgs = syncState.seenImgs || {};
  const photos = photosEnabled();
  let photoBudget = PHOTOS_PER_RUN;
  const changedBooks = new Set();
  let changedOther = false;

  applying = true;
  try {
    // 1) Löschmarkierungen zusammenführen und anwenden
    await db.mergeTombstones(lib.tombstones);
    const tomb = await db.getTombstones();
    for (const id of Object.keys(tomb.books)) {
      if (await db.getBook(id)) { await db.purgeBook(id); changedBooks.add(id); }
    }
    for (const id of Object.keys(tomb.folders || {})) {
      if (await db.getFolder(id)) { await db.deleteFolderRaw(id); changedOther = true; }
    }
    // Ordner (jüngste Änderung gewinnt)
    for (const [id, rf] of Object.entries(lib.folders || {})) {
      if ((tomb.folders || {})[id]) continue;
      const lf = await db.getFolder(id);
      if (!lf || (rf.updatedAt || 0) > (lf.updatedAt || 0)) { await db.putFolder({ ...rf, id }, { raw: true, silent: true }); changedOther = true; }
    }
    for (const id of Object.keys(tomb.profiles)) {
      if (await db.getProfile(id)) { await db.deleteProfile(id, { tombstone: false }); changedOther = true; }
    }

    // 2) Beim allerersten Abgleich dieses Geräts: gleichnamige Profile zusammenführen
    //    (sonst gäbe es z. B. zweimal „Ich“)
    if (!syncState.lastSync) await adoptRemoteProfiles(lib.profiles || {}, tomb);

    // 3) Profile
    const localProfiles = new Map((await db.getProfiles()).map((p) => [p.id, p]));
    for (const [id, rp] of Object.entries(lib.profiles || {})) {
      if (tomb.profiles[id]) continue;
      const lp = localProfiles.get(id);
      if (!lp || (rp.updatedAt || 0) > (lp.updatedAt || 0)) {
        await db.putProfile({ ...rp }, { raw: true, silent: true });
        changedOther = true;
      }
    }

    // 4) Bücher: Metadaten & Cover
    for (const [id, rb] of Object.entries(lib.books || {})) {
      if (tomb.books[id]) continue;
      const lb = await db.getBook(id);
      if (!lb) {
        const cover = rb.coverId ? await downloadCover(rb.coverId) : null;
        await db.putBookRaw({
          id, title: rb.title, author: rb.author || '', cover, coverId: cover ? rb.coverId : null, ignoredGaps: rb.ignoredGaps || [],
          folderId: rb.folderId || null, tags: rb.tags || [], locked: !!rb.locked, isbn: rb.isbn || null, source: rb.source || null,
          pageOrder: [], createdAt: rb.createdAt || Date.now(), updatedAt: Date.now(), metaAt: rb.metaAt || 0, orderAt: 0,
        }, { silent: true });
        changedBooks.add(id);
      } else if ((rb.metaAt || 0) > (lb.metaAt || 0)) {
        lb.title = rb.title; lb.author = rb.author || ''; lb.metaAt = rb.metaAt; lb.ignoredGaps = rb.ignoredGaps || [];
        lb.folderId = rb.folderId || null; lb.tags = rb.tags || []; lb.locked = !!rb.locked; lb.isbn = rb.isbn || null; lb.source = rb.source || null;
        if (rb.coverId !== lb.coverId) {
          lb.cover = rb.coverId ? await downloadCover(rb.coverId) : null;
          lb.coverId = lb.cover ? rb.coverId : null;
        }
        await db.putBookRaw(lb, { silent: true });
        changedBooks.add(id);
      }
    }

    // 5) Seitentexte je Buch
    // Verschlüsselte Bücher bei geschlossenem Tresor auslassen (werden nach dem Entsperren abgeglichen)
    const books = await db.getBooks();
    const sealedIds = new Set(books.filter((b) => b.enc && !vault.isOpen()).map((b) => b.id));
    for (const book of books) {
      if (sealedIds.has(book.id)) continue;
      const rb = (lib.books || {})[book.id];
      const remoteV = rb ? rb.contentV || 0 : 0;
      if (rb && remoteV > (seen[book.id] || 0)) {
        const file = await provider.read(`book-${book.id}.json`);
        if (file) {
          await mergeContent(book.id, JSON.parse(file.data), figsInCloud);
          changedBooks.add(book.id);
        }
      }
      // Abbildungen hochladen, die noch nicht in der Cloud liegen
      for (const f of await db.getFiguresOfBook(book.id)) {
        if (figsInCloud[f.id] || !f.image) continue;
        await provider.write(`fig-${f.id}.jpg`, f.image, 'image/jpeg');
        figsInCloud[f.id] = true;
      }
      const localV = await contentVersion(book.id);
      if (!rb || localV > remoteV) {
        await provider.write(`book-${book.id}.json`, JSON.stringify(await buildContent(book.id)), 'application/json');
      }
      seen[book.id] = Math.max(localV, remoteV);
      if (photos && !book.enc) photoBudget = await syncPhotos(book, rb, { imgs, imgsV, seenImgs, budget: photoBudget });
    }
    if (photos && photoBudget <= 0) pendingAgain = true; // noch Fotos übrig → gleich weitermachen

    // 6) Lesestände
    const localStates = new Map((await db.getAllStates()).map((s) => [s.key, s]));
    const profileIds = new Set((await db.getProfiles()).map((p) => p.id));
    const bookIds = new Set((await db.getBooks()).map((b) => b.id));
    for (const [key, rs] of Object.entries(lib.states || {})) {
      if (!profileIds.has(rs.profileId) || !bookIds.has(rs.bookId) || sealedIds.has(rs.bookId)) continue;
      const ls = localStates.get(key);
      // Markierungen beider Seiten zusammenführen (sonst ginge eine auf dem anderen Gerät verloren)
      const mergedHl = mergeHighlights(ls && ls.highlights, rs.highlights);
      // Lesestatus hat einen eigenen Zeitstempel (Öffnen ändert ihn, ohne die Position zu „berühren“)
      const st = ls && (ls.statusAt || 0) >= (rs.statusAt || 0) ? { status: ls.status ?? null, statusAt: ls.statusAt || 0 } : { status: rs.status ?? null, statusAt: rs.statusAt || 0 };
      if (!ls || (rs.updatedAt || 0) > (ls.updatedAt || 0)) {
        await db.putStateRaw({ ...rs, key, highlights: mergedHl, ...st }, { silent: true });
        changedOther = true;
      } else if (JSON.stringify(mergedHl) !== JSON.stringify(ls.highlights || []) || st.statusAt !== (ls.statusAt || 0)) {
        await db.putStateRaw({ ...ls, highlights: mergedHl, ...st }, { silent: true });
        changedOther = true;
      }
    }

    // 6b) Lesestatistik & Lernkarten
    if (await syncExtras(await db.getTombstones())) changedOther = true;

    // 7) Cover hochladen, die die Cloud noch nicht kennt
    for (const book of await db.getBooks()) {
      if (book.cover && book.coverId && (lib.books[book.id] || {}).coverId !== book.coverId) {
        await provider.write(`cover-${book.coverId}.jpg`, book.cover, 'image/jpeg');
      }
    }

    // 8) Neue library.json aus dem zusammengeführten Stand
    const next = await buildLibrary(imgsV, lib, sealedIds);
    if (stableStringify(strip(next)) !== stableStringify(strip(lib))) {
      next.updatedAt = Date.now();
      await provider.write(LIB, JSON.stringify(next), 'application/json', { ifVersion: remote ? remote.version : null });
    }
    await db.setMeta('sync', { seen, figs: figsInCloud, imgs, imgsV, seenImgs, lastSync: Date.now() });
  } finally {
    applying = false;
  }
  if (changedBooks.size || changedOther) db.emit('sync', null);
}

// ---------- Seitenfotos (optional) ----------

async function syncPhotos(book, rb, { imgs, imgsV, seenImgs, budget }) {
  const name = `imgs-${book.id}.json`;
  const remoteV = (rb && rb.imgsV) || 0;
  let list = null; // Inhalt von imgs-<id>.json
  const loadList = async () => {
    if (list) return list;
    const f = await provider.read(name).catch(() => null);
    try { list = f ? JSON.parse(f.data) : {}; } catch (e) { list = {}; }
    return list;
  };
  const pages = await db.getPagesOfBook(book.id);
  const tomb = (await db.getTombstones()).pages;
  let changed = false;

  // Herunterladen: Seiten ohne Foto (oder mit älterem), die in der Cloud ein Foto haben
  if (remoteV > (seenImgs[book.id] || 0)) {
    const l = await loadList();
    let complete = true;
    for (const p of pages) {
      const ver = l[p.id];
      if (!ver || imgs[p.id] === ver || p.photoDeleted) continue;
      if (p.image && (p.imageAt || p.createdAt || 0) >= ver) { imgs[p.id] = ver; continue; }
      if (budget <= 0) { complete = false; break; }
      const f = await provider.read(`img-${p.id}.jpg`, 'blob').catch(() => null);
      budget--;
      if (!f) continue;
      const image = new Blob([f.data], { type: 'image/jpeg' });
      const { makeThumb, loadBitmap } = await import('../imageproc.js');
      let thumb = p.thumb;
      if (!thumb) { try { thumb = await makeThumb(await loadBitmap(image)); } catch (e) { /* ohne Vorschau */ } }
      const cur = await db.getPage(p.id);
      if (cur) await db.putPage({ ...cur, image, thumb, imageAt: ver }, { silent: true });
      imgs[p.id] = ver;
    }
    if (complete) seenImgs[book.id] = remoteV;
  }

  // Hochladen: Fotos dieses Geräts, die noch nicht (in dieser Version) in der Cloud liegen
  for (const p of pages) {
    if (!p.image) continue;
    const ver = p.imageAt || p.createdAt || 1;
    if (imgs[p.id] === ver) continue;
    if (budget <= 0) break;
    await provider.write(`img-${p.id}.jpg`, p.image, 'image/jpeg');
    budget--;
    imgs[p.id] = ver;
    (await loadList())[p.id] = ver;
    changed = true;
  }
  // Gelöschte Seiten: Foto in der Cloud entfernen
  const l0 = list || (Object.keys(imgs).some((id) => tomb[id] && tomb[id].bookId === book.id) ? await loadList() : null);
  if (l0) {
    for (const id of Object.keys(l0)) {
      if (!tomb[id]) continue;
      await provider.remove(`img-${id}.jpg`).catch(() => {});
      delete l0[id]; delete imgs[id];
      changed = true;
    }
  }
  if (changed) {
    await provider.write(name, JSON.stringify(list), 'application/json');
    imgsV[book.id] = Date.now();
    seenImgs[book.id] = imgsV[book.id];
  }
  return budget;
}

// ---------- Lesestatistik & Lernkarten ----------

const EXTRAS = 'extras.json';
async function syncExtras(tomb) {
  const remote = await provider.read(EXTRAS).catch(() => null);
  let ex = { format: 'lesepixel-extras', version: 1, profiles: {} };
  if (remote) { try { ex = { ...ex, ...JSON.parse(remote.data) }; } catch (e) { /* neu aufbauen */ } }
  const dev = stats.deviceId();
  const next = { format: 'lesepixel-extras', version: 1, profiles: {} };
  const cutoff = stats.dayKey(new Date(Date.now() - 730 * 86400000));
  let changedLocal = false;
  for (const p of await db.getProfiles()) {
    const rp = (ex.profiles || {})[p.id] || {};
    const devices = { ...(rp.stats || {}) };
    delete devices[dev];
    const curRemote = (await db.getMeta('statsRemote|' + p.id)) || {};
    if (stableStringify(curRemote) !== stableStringify(devices)) { await db.setMeta('statsRemote|' + p.id, devices); changedLocal = true; }
    const own = await stats.ownStats(p.id);
    for (const k of Object.keys(own)) if (k < cutoff) delete own[k];
    const local = (await db.getMeta('cards|' + p.id)) || { cards: {} };
    const merged = mergeCards(local.cards, rp.cards);
    if (stableStringify(merged) !== stableStringify(local.cards || {})) { await db.setMeta('cards|' + p.id, { cards: merged }); changedLocal = true; }
    next.profiles[p.id] = { stats: { ...devices, ...(Object.keys(own).length ? { [dev]: { days: own } } : {}) }, cards: merged };
  }
  for (const [pid, rp] of Object.entries(ex.profiles || {})) if (!next.profiles[pid] && !(tomb.profiles || {})[pid]) next.profiles[pid] = rp;
  if (stableStringify(next.profiles) !== stableStringify(ex.profiles || {})) await provider.write(EXTRAS, JSON.stringify(next), 'application/json');
  return changedLocal;
}

async function adoptRemoteProfiles(remoteProfiles, tomb) {
  const remote = Object.values(remoteProfiles).filter((p) => !tomb.profiles[p.id]);
  if (!remote.length) return;
  const norm = (n) => (n || '').trim().toLowerCase();
  for (const lp of await db.getProfiles()) {
    if (remoteProfiles[lp.id]) continue;
    const rp = remote.find((r) => norm(r.name) === norm(lp.name));
    if (!rp) continue;
    await db.putProfile({ ...rp }, { raw: true, silent: true });
    // Lesestände des lokalen Profils übernehmen
    for (const st of await db.getStatesOfProfile(lp.id, { raw: true })) {
      const key = db.stateKey(rp.id, st.bookId);
      const existing = (await db.getAllStates({ raw: true })).find((x) => x.key === key);
      if (!existing || (st.updatedAt || 0) > (existing.updatedAt || 0)) await db.putStateRaw({ ...st, key, profileId: rp.id }, { silent: true });
    }
    if (profiles.currentId() === lp.id) await profiles.switchTo(rp.id);
    await db.deleteProfile(lp.id, { tombstone: false });
  }
}

// Vereinigung nach ID; bei gleicher ID gewinnt die jüngere Änderung (auch Löschungen)
function mergeHighlights(a = [], b = []) {
  const map = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    const cur = map.get(x.id);
    if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) map.set(x.id, x);
  }
  return [...map.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

function strip(lib) {
  const { updatedAt, ...rest } = lib;
  void updatedAt;
  return rest;
}

async function downloadCover(coverId) {
  try {
    const f = await provider.read(`cover-${coverId}.jpg`, 'blob');
    return f ? new Blob([f.data], { type: 'image/jpeg' }) : null;
  } catch (e) {
    console.warn('Cover nicht geladen', e);
    return null;
  }
}

async function buildLibrary(imgsV = {}, prev = null, sealedIds = new Set()) {
  const lib = emptyLib();
  for (const p of await db.getProfiles()) lib.profiles[p.id] = p;
  for (const f of await db.getFolders()) lib.folders[f.id] = f;
  for (const b of await db.getBooks()) {
    lib.books[b.id] = {
      id: b.id, title: b.title, author: b.author || '', coverId: b.cover ? b.coverId : null, ignoredGaps: b.ignoredGaps || [],
      folderId: b.folderId || null, tags: b.tags || [], locked: !!b.locked, isbn: b.isbn || null, source: b.source || null,
      createdAt: b.createdAt, metaAt: b.metaAt || 0,
      // Verschlüsselt und gesperrt: Inhalt wurde nicht abgeglichen → Stand aus der Cloud übernehmen
      contentV: sealedIds.has(b.id) ? ((prev && prev.books && prev.books[b.id] && prev.books[b.id].contentV) || 0) : await contentVersion(b.id),
      imgsV: Math.max(imgsV[b.id] || 0, (prev && prev.books && prev.books[b.id] && prev.books[b.id].imgsV) || 0) || undefined,
    };
  }
  for (const s of await db.getAllStates()) {
    if (!lib.profiles[s.profileId] || !lib.books[s.bookId]) continue;
    if (sealedIds.has(s.bookId)) { if (prev && prev.states && prev.states[s.key]) lib.states[s.key] = prev.states[s.key]; continue; }
    lib.states[s.key] = s;
  }
  lib.tombstones = await db.getTombstones();
  return lib;
}

// Versionsstempel des Buchinhalts = jüngste Änderung an Reihenfolge, Seiten oder Löschungen
async function contentVersion(bookId) {
  const book = await db.getBook(bookId);
  if (!book) return 0;
  let v = book.orderAt || 0;
  for (const p of await db.getPagesOfBook(bookId, { raw: true })) v = Math.max(v, p.updatedAt || 0);
  for (const f of await db.getFiguresOfBook(bookId, { raw: true })) v = Math.max(v, f.updatedAt || 0);
  const tomb = await db.getTombstones();
  for (const t of Object.values(tomb.pages)) if (t.bookId === bookId) v = Math.max(v, t.at);
  for (const t of Object.values(tomb.figures)) if (t.bookId === bookId) v = Math.max(v, t.at);
  return v;
}

async function buildContent(bookId) {
  const book = await db.getBook(bookId);
  const pages = {};
  for (const p of await db.getPagesOfBook(bookId)) {
    pages[p.id] = {
      text: p.text || '',
      ocrStatus: p.ocrStatus === 'done' || p.ocrStatus === 'error' ? p.ocrStatus : 'pending',
      confidence: p.confidence ?? null,
      printedNo: p.printedNo ?? null,
      printedNoManual: !!p.printedNoManual,
      paraY: p.paraY || null,
      createdAt: p.createdAt || 0,
      updatedAt: p.updatedAt || 0,
    };
  }
  const figures = {};
  for (const f of await db.getFiguresOfBook(bookId)) {
    figures[f.id] = { pageId: f.pageId, rect: f.rect, w: f.w, h: f.h, caption: f.caption || '', fullPage: !!f.fullPage, createdAt: f.createdAt || 0, updatedAt: f.updatedAt || 0 };
  }
  const tomb = await db.getTombstones();
  const deletedPages = {};
  for (const [id, t] of Object.entries(tomb.pages)) if (t.bookId === bookId) deletedPages[id] = t;
  const deletedFigures = {};
  for (const [id, t] of Object.entries(tomb.figures)) if (t.bookId === bookId) deletedFigures[id] = t;
  return { format: 'openbook-book', version: 1, id: bookId, pageOrder: book.pageOrder, orderAt: book.orderAt || 0, pages, deletedPages, figures, deletedFigures };
}

async function mergeContent(bookId, remote, figsInCloud) {
  const remoteTomb = {};
  for (const [id, t] of Object.entries(remote.deletedPages || {})) remoteTomb[id] = { ...t, bookId };
  const remoteFigTomb = {};
  for (const [id, t] of Object.entries(remote.deletedFigures || {})) remoteFigTomb[id] = { ...t, bookId };
  await db.mergeTombstones({ pages: remoteTomb, figures: remoteFigTomb });
  const allTomb = await db.getTombstones();
  const tomb = allTomb.pages;

  const local = new Map((await db.getPagesOfBook(bookId)).map((p) => [p.id, p]));
  for (const [id, rp] of Object.entries(remote.pages || {})) {
    if (tomb[id]) continue;
    const lp = local.get(id);
    if (!lp) {
      const page = {
        id, bookId, image: null, thumb: null,
        text: rp.text || '',
        ocrStatus: rp.ocrStatus === 'done' || rp.ocrStatus === 'error' ? rp.ocrStatus : 'remote',
        confidence: rp.confidence ?? null, createdAt: rp.createdAt || 0, updatedAt: rp.updatedAt || 0,
        printedNo: rp.printedNo ?? null, printedNoManual: !!rp.printedNoManual, paraY: rp.paraY || null,
      };
      await db.putPage(page, { silent: true });
      local.set(id, page);
    } else if ((rp.updatedAt || 0) > (lp.updatedAt || 0)) {
      lp.text = rp.text || '';
      lp.confidence = rp.confidence ?? null;
      lp.printedNo = rp.printedNo ?? null;
      lp.printedNoManual = !!rp.printedNoManual;
      lp.paraY = rp.paraY || null;
      lp.updatedAt = rp.updatedAt;
      if (rp.ocrStatus === 'done' || rp.ocrStatus === 'error') lp.ocrStatus = rp.ocrStatus;
      else if (!lp.image) lp.ocrStatus = 'remote';
      await db.putPage(lp, { silent: true });
    }
  }
  for (const id of [...local.keys()]) {
    if (tomb[id]) { await db.deletePageRaw(id); local.delete(id); }
  }

  // Abbildungen
  const localFigs = new Map((await db.getFiguresOfBook(bookId)).map((f) => [f.id, f]));
  for (const id of localFigs.keys()) {
    if (allTomb.figures[id]) { await db.deleteFigure(id, { tombstone: false }); localFigs.delete(id); }
  }
  for (const [id, rf] of Object.entries(remote.figures || {})) {
    if (allTomb.figures[id] || !local.has(rf.pageId)) continue;
    const lf = localFigs.get(id);
    if (!lf) {
      const file = await provider.read(`fig-${id}.jpg`, 'blob').catch(() => null);
      if (!file) continue; // Bild noch nicht hochgeladen → beim nächsten Mal
      await db.putFigureRaw({ id, bookId, ...rf, image: new Blob([file.data], { type: 'image/jpeg' }) }, { silent: true });
      figsInCloud[id] = true;
    } else {
      figsInCloud[id] = true;
      if ((rf.updatedAt || 0) > (lf.updatedAt || 0)) await db.putFigureRaw({ ...lf, ...rf, id, bookId, image: lf.image }, { silent: true });
    }
  }

  const book = await db.getBook(bookId);
  let order = (remote.orderAt || 0) > (book.orderAt || 0) ? remote.pageOrder || [] : book.pageOrder;
  let orderAt = Math.max(remote.orderAt || 0, book.orderAt || 0);
  order = order.filter((id, i) => local.has(id) && order.indexOf(id) === i);
  // Seiten, die in keiner Reihenfolge vorkommen (z. B. gleichzeitig auf zwei Geräten gescannt), hinten anhängen
  const inOrder = new Set(order);
  const orphans = [...local.values()].filter((p) => !inOrder.has(p.id)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (orphans.length) { order = order.concat(orphans.map((p) => p.id)); orderAt = Date.now(); }
  book.pageOrder = order;
  book.orderAt = orderAt;
  await db.putBookRaw(book, { silent: true });
}

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
