// Suche über alle Bücher: Titel, Autor, Tags und den erkannten Text aller Seiten.

import * as db from './db.js';
import { splitParas } from './textproc.js';
import { parseBlock } from './rich.js';

// Groß-/Kleinschreibung und Umlaut-Schreibweisen (ä/ae …) ignorieren, Positionen bleiben gleich lang
function fold(s) {
  return s.toLowerCase().replace(/ß/g, 's').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// → [{ book, titleHit, hits: [{ pageId, pageIndex, printedNo, p, char, before, match, after }], total }]
export async function searchLibrary(query, { canOpen = () => true, maxPerBook = 5, maxBooks = 50 } = {}) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const out = [];
  for (const book of await db.getBooks()) {
    if (!canOpen(book)) continue;
    const meta = fold([book.title, book.author, ...(book.tags || [])].join(' '));
    const titleHit = meta.includes(q);
    const pages = await db.getPagesMeta(book.id, { images: false });
    const hits = [];
    let total = 0;
    pages.forEach((page, pageIndex) => {
      splitParas(page.text).forEach((md, p) => {
        const plain = parseBlock(md).plain;
        const low = fold(plain);
        let at = low.indexOf(q);
        while (at >= 0) {
          total++;
          if (hits.length < maxPerBook) {
            const a = Math.max(0, at - 45), b = Math.min(plain.length, at + q.length + 55);
            hits.push({
              pageId: page.id, pageIndex, printedNo: page.printedNo || null, p, char: at,
              before: (a > 0 ? '…' : '') + plain.slice(a, at),
              match: plain.slice(at, at + q.length),
              after: plain.slice(at + q.length, b) + (b < plain.length ? '…' : ''),
            });
          }
          at = low.indexOf(q, at + q.length);
        }
      });
    });
    if (titleHit || total) out.push({ book, titleHit, hits, total });
    if (out.length >= maxBooks) break;
  }
  // Treffer im Titel zuerst, dann nach Anzahl
  out.sort((x, y) => (y.titleHit - x.titleHit) || (y.total - x.total));
  return out;
}

// Sprungziel für den Leser merken (wird beim Öffnen des Buchs ausgewertet)
export function setJump(bookId, hit) {
  try { sessionStorage.setItem('ob.jump', JSON.stringify({ bookId, pageId: hit.pageId, p: hit.p, char: hit.char })); } catch (e) { /* */ }
}
export function takeJump(bookId) {
  try {
    const j = JSON.parse(sessionStorage.getItem('ob.jump') || 'null');
    if (j && j.bookId === bookId) { sessionStorage.removeItem('ob.jump'); return j; }
  } catch (e) { /* */ }
  return null;
}
