// Sicherung & Wiederherstellung der Bibliothek als ZIP (Metadaten + Fotos).

import * as db from './db.js';
import { loadJSZip } from './zip.js';

const FORMAT = 'openbook-backup';

export async function exportBackup(bookIds = null) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const books = (await db.getBooks()).filter((b) => !bookIds || bookIds.includes(b.id));
  const meta = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), books: [] };
  for (const b of books) {
    const pages = await db.getPagesMeta(b.id);
    const { cover, ...rest } = b;
    if (cover) zip.file(`books/${b.id}/cover.jpg`, cover);
    meta.books.push({
      ...rest,
      hasCover: !!cover,
      pages: pages.map((p) => {
        zip.file(`books/${b.id}/pages/${p.id}.jpg`, p.image);
        zip.file(`books/${b.id}/thumbs/${p.id}.jpg`, p.thumb);
        return { id: p.id, text: p.text, ocrStatus: p.ocrStatus === 'done' ? 'done' : 'pending', confidence: p.confidence, createdAt: p.createdAt };
      }),
    });
  }
  zip.file('openbook.json', JSON.stringify(meta, null, 1));
  // Fotos sind schon JPEG → nicht noch einmal komprimieren
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export async function importBackup(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const metaFile = zip.file('openbook.json');
  if (!metaFile) throw new Error('Keine openBook-Sicherung');
  const meta = JSON.parse(await metaFile.async('string'));
  if (meta.format !== FORMAT) throw new Error('Unbekanntes Format');
  const existing = new Set((await db.getBooks()).map((b) => b.id));
  let n = 0;
  for (const mb of meta.books) {
    // Bereits vorhandene Bücher werden als Kopie importiert
    const id = existing.has(mb.id) ? db.uid() : mb.id;
    const cover = mb.hasCover ? await blobOf(zip, `books/${mb.id}/cover.jpg`) : null;
    const pageIds = [];
    for (const mp of mb.pages) {
      const image = await blobOf(zip, `books/${mb.id}/pages/${mp.id}.jpg`);
      const thumb = (await blobOf(zip, `books/${mb.id}/thumbs/${mp.id}.jpg`)) || image;
      if (!image) continue;
      const pid = existing.has(mb.id) ? db.uid() : mp.id;
      await db.putPage({
        id: pid, bookId: id, image, thumb,
        text: mp.text ?? null,
        ocrStatus: mp.ocrStatus === 'done' ? 'done' : 'pending',
        confidence: mp.confidence ?? null,
        createdAt: mp.createdAt || Date.now(),
      });
      pageIds.push(pid);
    }
    const { pages, hasCover, ...rest } = mb;
    void pages; void hasCover;
    const copy = existing.has(mb.id);
    await db.putBook({
      ...rest,
      id,
      title: copy ? `${mb.title} (Kopie)` : mb.title,
      cover,
      pageOrder: pageIds,
      position: copy ? null : mb.position,
      bookmarks: copy ? [] : (mb.bookmarks || []),
    });
    n++;
  }
  return n;
}

async function blobOf(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const buf = await f.async('arraybuffer');
  return new Blob([buf], { type: 'image/jpeg' });
}
