// Sicherung & Wiederherstellung der Bibliothek als ZIP (Metadaten + Fotos).

import * as db from './db.js';
import { loadJSZip } from './zip.js';
import * as profiles from './profiles.js';

const FORMAT = 'openbook-backup';

// photos=false: nur Text, Cover und Abbildungen (viel kleiner, z. B. für die Übertragung)
export async function exportBackup(bookIds = null, { photos = true } = {}) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const books = (await db.getBooks()).filter((b) => !bookIds || bookIds.includes(b.id));
  const meta = { format: FORMAT, version: 2, exportedAt: new Date().toISOString(), books: [] };
  const allStates = await db.getAllStates();
  for (const b of books) {
    const pages = await db.getPagesMeta(b.id);
    const { cover, enc, ...rest } = b; // Sicherung enthält Klartext → nicht als verschlüsselt markieren
    void enc;
    if (cover) zip.file(`books/${b.id}/cover.jpg`, cover);
    meta.books.push({
      ...rest,
      hasCover: !!cover,
      states: allStates.filter((s) => s.bookId === b.id),
      pages: pages.map((p) => {
        if (photos && p.image) zip.file(`books/${b.id}/pages/${p.id}.jpg`, p.image);
        if (photos && p.thumb) zip.file(`books/${b.id}/thumbs/${p.id}.jpg`, p.thumb);
        return { id: p.id, text: p.text, ocrStatus: p.ocrStatus === 'done' ? 'done' : 'pending', confidence: p.confidence, createdAt: p.createdAt, hasImage: !!p.image, printedNo: p.printedNo ?? null, printedNoManual: !!p.printedNoManual, paraY: p.paraY || null };
      }),
      figures: (await db.getFiguresOfBook(b.id)).map((f) => {
        zip.file(`books/${b.id}/figures/${f.id}.jpg`, f.image);
        const { image, ...meta } = f;
        void image;
        return meta;
      }),
    });
  }
  zip.file('openbook.json', JSON.stringify(meta, null, 1));
  if (!bookIds) db.setMeta('lastBackupAt', Date.now()); // für die Sicherungs-Erinnerung
  // Fotos sind schon JPEG → nicht noch einmal komprimieren
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

// → Anzahl der Bücher; importBackupDetailed liefert zusätzlich die IDs
export async function importBackup(file) {
  return (await importBackupDetailed(file)).count;
}

export async function importBackupDetailed(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const metaFile = zip.file('openbook.json');
  if (!metaFile) throw new Error('Keine Lesepixel-Sicherung');
  const meta = JSON.parse(await metaFile.async('string'));
  if (meta.format !== FORMAT) throw new Error('Unbekanntes Format');
  const existing = new Set((await db.getBooks()).map((b) => b.id));
  let n = 0;
  const bookIds = [];
  for (const mb of meta.books) {
    // Bereits vorhandene Bücher werden als Kopie importiert
    const id = existing.has(mb.id) ? db.uid() : mb.id;
    const cover = mb.hasCover ? await blobOf(zip, `books/${mb.id}/cover.jpg`) : null;
    const pageIds = [];
    const pageIdMap = new Map();
    for (const mp of mb.pages) {
      const image = await blobOf(zip, `books/${mb.id}/pages/${mp.id}.jpg`);
      const thumb = (await blobOf(zip, `books/${mb.id}/thumbs/${mp.id}.jpg`)) || image;
      if (!image && !mp.text) continue;
      const pid = existing.has(mb.id) ? db.uid() : mp.id;
      await db.putPage({
        id: pid, bookId: id, image, thumb,
        text: mp.text ?? null,
        ocrStatus: mp.ocrStatus === 'done' || !image ? 'done' : 'pending',
        confidence: mp.confidence ?? null,
        createdAt: mp.createdAt || Date.now(),
        updatedAt: Date.now(),
        printedNo: mp.printedNo ?? null,
        printedNoManual: !!mp.printedNoManual,
        paraY: mp.paraY || null,
      });
      pageIdMap.set(mp.id, pid);
      pageIds.push(pid);
    }
    const copy = existing.has(mb.id);
    const now = Date.now();
    await db.putBookRaw({
      id,
      title: copy ? `${mb.title} (Kopie)` : mb.title,
      author: mb.author || '',
      cover,
      coverId: cover ? db.uid() : null,
      pageOrder: pageIds,
      createdAt: mb.createdAt || now,
      updatedAt: now,
      metaAt: now,
      orderAt: now,
      ignoredGaps: mb.ignoredGaps || [],
      folderId: null,
      tags: mb.tags || [],
      isbn: mb.isbn || null,
      source: mb.source || null,
    });
    for (const mf of mb.figures || []) {
      const image = await blobOf(zip, `books/${mb.id}/figures/${mf.id}.jpg`);
      const pid = pageIdMap.get(mf.pageId);
      if (!image || !pid) continue;
      await db.putFigureRaw({ ...mf, id: copy ? db.uid() : mf.id, bookId: id, pageId: pid, image, updatedAt: now });
    }
    // Lesestände (Format v2) bzw. alte Leseposition (Format v1) übernehmen
    const profileId = profiles.currentId();
    if (!copy && Array.isArray(mb.states)) {
      for (const st of mb.states) {
        if (await db.getProfile(st.profileId)) await db.putStateRaw({ ...st, key: db.stateKey(st.profileId, id), bookId: id, updatedAt: now });
      }
    } else if (!copy && profileId && (mb.position || (mb.bookmarks || []).length)) {
      await db.updateState(profileId, id, { position: mb.position || null, bookmarks: mb.bookmarks || [] });
    }
    n++;
    bookIds.push(id);
  }
  return { count: n, bookIds };
}

async function blobOf(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const buf = await f.async('arraybuffer');
  return new Blob([buf], { type: 'image/jpeg' });
}
