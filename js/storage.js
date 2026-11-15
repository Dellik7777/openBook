// Speicher sparen: Fotos eines Buchs verkleinern oder ganz entfernen (Text bleibt).

import * as db from './db.js';
import { loadBitmap, toBlob, makeThumb } from './imageproc.js';

export async function bookSize(bookId) {
  let photos = 0, other = 0;
  for (const p of await db.getPagesOfBook(bookId)) {
    photos += (p.image ? p.image.size : 0) + (p.orig ? p.orig.size : 0);
    other += (p.thumb ? p.thumb.size : 0) + (p.text ? p.text.length * 2 : 0);
  }
  for (const f of await db.getFiguresOfBook(bookId)) other += f.image ? f.image.size : 0;
  const b = await db.getBook(bookId);
  if (b && b.cover) other += b.cover.size;
  return { photos, other, total: photos + other };
}

export function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1e3)) + ' KB';
}

// Fotos auf max. 1300 px und stärkere Kompression bringen (reicht zum Ansehen, OCR ist schon erledigt)
export async function shrinkPhotos(bookId, onProgress) {
  const pages = (await db.getPagesOfBook(bookId)).filter((p) => p.image);
  let saved = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const src = await loadBitmap(p.image);
    const w = src.width || src.naturalWidth, hgt = src.height || src.naturalHeight;
    const scale = Math.min(1, 1300 / Math.max(w, hgt));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(hgt * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    const img = await toBlob(c, 'image/jpeg', 0.6);
    if (img.size < p.image.size) {
      saved += p.image.size - img.size;
      // Verkleinern: auch das unbearbeitete Original (für „Ecken anpassen“) entfällt
      saved += p.orig ? p.orig.size : 0;
      await db.putPage({ ...p, image: img, orig: null, imageAt: Date.now(), thumb: p.thumb || await makeThumb(c) }, { silent: true });
    }
    onProgress && onProgress((i + 1) / pages.length);
  }
  db.emit('pages', bookId);
  return saved;
}

// Seitenfotos löschen – nur Text, Vorschaubilder und Abbildungen bleiben
export async function deletePhotos(bookId) {
  let saved = 0;
  for (const p of await db.getPagesOfBook(bookId)) {
    if (!p.image) continue;
    if (p.ocrStatus !== 'done') continue; // ohne erkannten Text wäre die Seite verloren
    saved += p.image.size;
    saved += p.orig ? p.orig.size : 0;
    await db.putPage({ ...p, image: null, orig: null, photoDeleted: true }, { silent: true }); // nicht wieder aus der Cloud laden
  }
  db.emit('pages', bookId);
  return saved;
}
