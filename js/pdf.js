// Durchsuchbares PDF: Seitenfoto (JPEG) + unsichtbare Textebene an der Position der erkannten Zeilen.
// Seiten ohne Foto (per Sync übertragen) werden als einfache Textseiten gesetzt.
// Eigener, schlanker PDF-Schreiber (PDF 1.4, Helvetica mit WinAnsi-Kodierung).

import * as db from './db.js';
import { splitParas } from './textproc.js';
import { parseBlock } from './rich.js';

const PAGE_W = 595.28; // A4-Breite in Punkt

// Unicode → WinAnsi (deutsche Texte inkl. typografischer Anführungszeichen)
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
function winAnsi(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += ch;
    else out += '?';
  }
  return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
// Metadaten als UTF-16 (Umlaute und Anführungszeichen korrekt)
const uni = (str) => '<FEFF' + [...str].map((ch) => { const c = ch.codePointAt(0); const u = c > 0xffff ? String.fromCodePoint(c) : ch; return [...u].map((x) => x.charCodeAt(0).toString(16).padStart(4, '0')).join(''); }).join('').toUpperCase() + '>';
const bytes = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
const fmt = (n) => (Math.round(n * 100) / 100).toString();
// grobe Breite von Helvetica (in Einheiten der Schriftgröße)
const textWidth = (s, size) => [...s].reduce((w, ch) => w + (/[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-ZÄÖÜ]/.test(ch) ? 0.67 : ch === ' ' ? 0.28 : 0.53), 0) * size;

export async function exportPdf(bookId, onProgress) {
  const book = await db.getBook(bookId);
  const pages = await db.getPagesMeta(bookId);
  const objs = []; // Index = Objektnummer - 1
  const add = (parts) => { objs.push(parts); return objs.length; };
  // 1: Katalog, 2: Seitenbaum, 3: Schrift, 4: Info (werden am Ende gefüllt)
  add(null); add(null);
  add([`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`]);
  add([`<< /Title ${uni(book.title)} /Author ${uni(book.author || '')} /Creator (Lesepixel) /Producer (Lesepixel) >>`]);
  const kids = [];

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let content = '';
    let pageH, xobj = null;
    if (p.image) {
      const bmp = await createImageBitmap(p.image);
      const iw = bmp.width, ih = bmp.height;
      if (bmp.close) bmp.close();
      pageH = PAGE_W * ih / iw;
      const jpg = new Uint8Array(await p.image.arrayBuffer());
      xobj = add([`<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
      content += `q ${fmt(PAGE_W)} 0 0 ${fmt(pageH)} 0 0 cm /Im0 Do Q\n`;
      // Unsichtbare Textebene (Rendermodus 3): Zeilen aus der Texterkennung, sonst Absätze verteilt
      const lines = Array.isArray(p.lines) && p.lines.length ? p.lines : approxLines(p);
      content += 'BT 3 Tr\n';
      for (const ln of lines) {
        const hgt = (ln.y1 - ln.y0) * pageH;
        const size = Math.max(4, hgt * 0.85);
        const x = ln.x0 * PAGE_W, y = pageH - ln.y1 * pageH + hgt * 0.15;
        const targetW = (ln.x1 - ln.x0) * PAGE_W;
        const natural = textWidth(ln.t, size) || 1;
        const tz = Math.max(20, Math.min(400, (targetW / natural) * 100));
        content += `/F1 ${fmt(size)} Tf ${fmt(tz)} Tz 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (${winAnsi(ln.t)}) Tj\n`;
      }
      content += 'ET\n';
    } else {
      // Textseite ohne Foto: sichtbar setzen
      pageH = PAGE_W * 1.414;
      content += textPage(p, pageH);
    }
    const stream = bytes(content);
    const cs = add([`<< /Length ${stream.length} >>\nstream\n`, stream, '\nendstream']);
    const res = `<< /Font << /F1 3 0 R >>${xobj ? ` /XObject << /Im0 ${xobj} 0 R >>` : ''} >>`;
    kids.push(add([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W)} ${fmt(pageH)}] /Resources ${res} /Contents ${cs} 0 R >>`]));
    onProgress && onProgress((i + 1) / pages.length);
  }
  objs[0] = [`<< /Type /Catalog /Pages 2 0 R >>`];
  objs[1] = [`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`];

  // Datei zusammensetzen
  const chunks = [bytes('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((parts, idx) => {
    offsets.push(offset);
    const pieces = [bytes(`${idx + 1} 0 obj\n`), ...parts.map((x) => (typeof x === 'string' ? bytes(x) : x)), bytes('\nendobj\n')];
    for (const pc of pieces) { chunks.push(pc); offset += pc.length; }
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '];
  for (const o of offsets) xref.push(String(o).padStart(10, '0') + ' 00000 n ');
  chunks.push(bytes(xref.join('\n') + `\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Blob(chunks, { type: 'application/pdf' });
}

// Ohne gespeicherte Zeilenlage: Absätze gleichmäßig über die Seite verteilen (Suche funktioniert trotzdem)
function approxLines(p) {
  const paras = splitParas(p.text).map((m) => parseBlock(m).plain);
  const ys = Array.isArray(p.paraY) && p.paraY.length === paras.length ? p.paraY : paras.map((_, i) => 0.08 + 0.84 * i / Math.max(1, paras.length));
  return paras.map((t, i) => ({ t, x0: 0.08, x1: 0.92, y0: ys[i], y1: Math.min(0.98, ys[i] + 0.02) }));
}

function textPage(p, pageH) {
  const margin = 56, size = 11, lead = 15;
  const maxW = PAGE_W - 2 * margin;
  let y = pageH - margin;
  let out = 'BT\n';
  for (const md of splitParas(p.text)) {
    const blk = parseBlock(md);
    const sz = blk.type === 'h1' ? 16 : blk.type === 'h2' ? 13 : size;
    const indent = blk.type === 'li' ? 14 + 14 * (blk.level || 0) : 0;
    const plain = blk.type === 'table' ? blk.rows.map((r) => r.map((c) => parseBlock(c).plain).join('  |  ')).join(' \n ') : blk.plain;
    const words = ((blk.type === 'li' && !blk.ordered ? '• ' : '') + plain).split(/ +/);
    let line = '';
    const flush = () => {
      if (!line) return;
      if (y < margin) return;
      out += `/F1 ${sz} Tf 1 0 0 1 ${fmt(margin + indent)} ${fmt(y)} Tm (${winAnsi(line)}) Tj\n`;
      y -= sz === size ? lead : sz * 1.35;
      line = '';
    };
    for (const w of words) {
      if (w === '\n') { flush(); continue; }
      const test = line ? line + ' ' + w : w;
      if (textWidth(test, sz) > maxW - indent) { flush(); line = w; } else line = test;
    }
    flush();
    y -= 6;
  }
  return out + 'ET\n';
}
