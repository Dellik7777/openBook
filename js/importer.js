// Vorhandene PDF- und EPUB-Dateien als Buch importieren.
//
// PDF: Jede Seite wird als Bild gespeichert (Originalansicht, optional). Hat das PDF eine
//      Textebene, wird der Text direkt übernommen (inkl. Absätze, Überschriften, fett/kursiv,
//      Seitenzahl) – sonst läuft die normale Texterkennung.
// EPUB: Kapitel werden in Abschnitte („Seiten“) zu ca. 1800 Zeichen geteilt, Bilder werden
//      zu Abbildungen, Tabellen und Fußnoten bleiben erhalten. Kopiergeschützte (DRM) EPUBs
//      lassen sich nicht öffnen.

import * as db from './db.js';
import * as ocr from './ocr.js';
import { analyzeOcr } from './textproc.js';
import { escapeMd, tableMd, parseBlock } from './rich.js';
import { loadJSZip } from './zip.js';
import { loadBitmap, toBlob, makeThumb, processCover } from './imageproc.js';
import { normalizeIsbn } from './barcode.js';

export const ACCEPT = '.pdf,.epub,application/pdf,application/epub+zip';

export function kindOf(file) {
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (n.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub';
  return null;
}

const baseName = (file) => (file.name || 'Import').replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ').trim();

// ---------------------------------------------------------------- PDF

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw new Error('PDF-Modul konnte nicht geladen werden: ' + e.message); });
  }
  return pdfjsPromise;
}

const PDF_EDGE = 2000;

// Öffnet ein PDF (fragt bei Bedarf nach dem Kennwort) → { pdf, info }
export async function openPdf(file, askPassword) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({ data, isEvalSupported: false, disableAutoFetch: true });
  task.onPassword = async (update, reason) => {
    const pw = askPassword ? await askPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD) : null;
    if (pw == null) { task.destroy(); return; }
    update(pw);
  };
  const pdf = await task.promise;
  let info = {};
  try { info = (await pdf.getMetadata()).info || {}; } catch (e) { /* ohne Metadaten */ }
  return { pdf, info, lib };
}

export async function importPdf(file, { folderId = null, keepImages = true, onProgress, signal, askPassword } = {}) {
  const { pdf, info, lib } = await openPdf(file, askPassword);
  const title = (info.Title && String(info.Title).trim().length > 1 && !/^untitled|^microsoft word|\.docx?$/i.test(info.Title)) ? String(info.Title).trim() : baseName(file);
  const book = await db.createBook({ title, author: info.Author ? String(info.Author).trim() : '' });
  await db.updateBook(book.id, { source: 'pdf', ...(folderId ? { folderId } : {}) });
  const n = pdf.numPages;
  let scanned = 0;
  try {
    for (let i = 1; i <= n; i++) {
      if (signal && signal.aborted) break;
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = PDF_EDGE / Math.max(vp1.width, vp1.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const tc = await page.getTextContent();
      const fontInfo = (name) => {
        try { if (page.commonObjs.has(name)) { const f = page.commonObjs.get(name); return (f && (f.name || f.loadedName)) || ''; } } catch (e) { /* */ }
        return (tc.styles[name] && tc.styles[name].fontFamily) || '';
      };
      const lines = pdfLines(tc.items, viewport, lib.Util, fontInfo, canvas.width);
      const chars = lines.reduce((s, l) => s + l.text.length, 0);
      const thumb = await makeThumb(canvas);
      if (i === 1) {
        const cover = await processCover(await toBlob(canvas, 'image/jpeg', 0.85));
        await db.updateBook(book.id, { cover });
      }
      if (chars < 15) {
        // Gescannte Seite ohne Textebene → Texterkennung
        const image = await toBlob(canvas);
        const p = await db.addPage(book.id, { image, thumb });
        ocr.enqueue(p.id);
        scanned++;
      } else {
        const res = analyzeOcr(toOcrData(lines), { height: canvas.height });
        const image = keepImages ? await toBlob(canvas) : null;
        await db.addPage(book.id, {
          image, thumb,
          text: res.paras.join('\n\n'), paraY: res.paraY, printedNo: res.printedNo, ocrStatus: 'done', confidence: 100,
          lines: lines.map((l) => ({ t: l.text, x0: r4(l.x0 / canvas.width), y0: r4(l.y0 / canvas.height), x1: r4(l.x1 / canvas.width), y1: r4(l.y1 / canvas.height) })),
        });
      }
      page.cleanup();
      canvas.width = canvas.height = 1;
      onProgress && onProgress(i / n, `Seite ${i} von ${n}`);
    }
  } finally {
    pdf.destroy();
  }
  return { bookId: book.id, pages: n, scanned };
}

const r4 = (v) => Math.round(v * 10000) / 10000;

// Textstücke des PDFs → Zeilen mit Wörtern (Bildkoordinaten), in Lesereihenfolge
export function pdfLines(items, viewport, Util, fontInfo, W) {
  const segs = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = Util.transform(viewport.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (fh < 3) continue;
    if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.2 + 0.01) continue; // gedrehter Text (Randvermerke)
    const x0 = tx[4], base = tx[5];
    const w = Math.max((it.width || 0) * viewport.scale, it.str.length * fh * 0.3);
    const font = fontInfo(it.fontName) || '';
    segs.push({
      str: it.str, x0, x1: x0 + w, base, fh, y0: base - fh * 0.8, y1: base + fh * 0.22,
      bold: /bold|black|heavy|semibold|demi/i.test(font), italic: /italic|oblique|kursiv/i.test(font),
    });
  }
  segs.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  // Stücke auf gleicher Grundlinie zu Zeilen zusammenfassen (große Lücken = andere Spalte)
  const lines = [];
  for (const s of segs) {
    const cand = lines.filter((l) => Math.abs(l.base - s.base) < Math.min(l.fh, s.fh) * 0.45 && s.x0 >= l.x1 - s.fh * 0.6 && s.x0 - l.x1 < s.fh * 2.5);
    const l = cand.sort((a, b) => b.x1 - a.x1)[0];
    if (l) { l.segs.push(s); l.x1 = Math.max(l.x1, s.x1); l.y0 = Math.min(l.y0, s.y0); l.y1 = Math.max(l.y1, s.y1); l.fh = Math.max(l.fh, s.fh); }
    else lines.push({ segs: [s], x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1, base: s.base, fh: s.fh });
  }
  for (const l of lines) {
    l.segs.sort((a, b) => a.x0 - b.x0);
    l.words = [];
    let prev = null;
    for (const s of l.segs) {
      const glue = prev && s.x0 - prev.x1 < s.fh * 0.12 && !/\s$/.test(prev.str) && !/^\s/.test(s.str);
      const parts = s.str.split(/(\s+)/);
      const per = (s.x1 - s.x0) / Math.max(1, s.str.length);
      let pos = 0;
      parts.forEach((part, k) => {
        if (part && !/^\s+$/.test(part)) {
          const bbox = { x0: s.x0 + pos * per, x1: s.x0 + (pos + part.length) * per, y0: s.y0, y1: s.y1 };
          const last = l.words[l.words.length - 1];
          if (k === 0 && glue && last) { last.text += part; last.bbox.x1 = bbox.x1; }
          else l.words.push({ text: part, bbox, confidence: 99, bold: s.bold, italic: s.italic });
        }
        pos += part.length;
      });
      prev = s;
    }
    l.text = l.words.map((w) => w.text).join(' ');
  }
  // Zwei Spalten? Dann erst die linke, dann die rechte Spalte lesen
  const mid = W / 2;
  const left = lines.filter((l) => l.x1 < mid + W * 0.02).length;
  const right = lines.filter((l) => l.x0 > mid - W * 0.02).length;
  const across = lines.filter((l) => l.x0 < mid - W * 0.05 && l.x1 > mid + W * 0.05).length;
  const twoCol = lines.length > 8 && left > lines.length * 0.3 && right > lines.length * 0.3 && across < lines.length * 0.15;
  const colOf = (l) => (twoCol && l.x0 > mid - W * 0.02 ? 1 : 0);
  lines.sort((a, b) => colOf(a) - colOf(b) || a.y0 - b.y0 || a.x0 - b.x0);
  lines.forEach((l) => { l.col = colOf(l); });
  return lines.filter((l) => l.text.trim());
}

// Zeilen → Struktur wie bei der Texterkennung (Blöcke → Absätze → Zeilen → Wörter)
function toOcrData(lines) {
  const paras = [];
  let cur = null, prev = null;
  const right = [0, 0];
  for (const l of lines) right[l.col] = Math.max(right[l.col], l.x1);
  for (const l of lines) {
    const gap = prev ? l.y0 - prev.y1 : 0;
    const same = prev && prev.col === l.col && gap < Math.min(l.fh, prev.fh) * 0.75 && gap > -l.fh * 0.5
      && Math.abs(l.fh - prev.fh) < prev.fh * 0.18
      && !(l.x0 > prev.x0 + l.fh * 0.8 && /[.!?:"“”»]$/.test(prev.text)) // Einzug = neuer Absatz
      && !(prev.x1 < right[l.col] - l.fh * 4 && /^[A-ZÄÖÜ0-9„"»]/.test(l.text)); // kurze Zeile davor = Absatzende
    if (!same) { cur = []; paras.push(cur); }
    cur.push({ text: l.text, bbox: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }, confidence: 99, words: l.words });
    prev = l;
  }
  return { blocks: paras.map((p) => ({ paragraphs: [{ lines: p }] })), text: '' };
}

// ---------------------------------------------------------------- EPUB

const PAGE_CHARS = 1800;
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'template']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'blockquote', 'figcaption', 'pre', 'dl', 'dt', 'dd', 'hr', 'body', 'center', 'address', 'aside', 'nav', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table']);

const epubType = (el) => ((el.getAttribute && (el.getAttribute('epub:type') || el.getAttributeNS && el.getAttributeNS('http://www.idpf.org/2007/ops', 'type'))) || '') + ' ' + ((el.getAttribute && el.getAttribute('role')) || '');
const local = (el) => (el.localName || el.nodeName || '').toLowerCase();

function resolvePath(base, href) {
  try {
    const u = new URL(href, 'http://x/' + base);
    return decodeURIComponent(u.pathname.slice(1));
  } catch (e) { return href; }
}

function parseXml(text, type = 'application/xhtml+xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) return new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

function runsToMd(runs) {
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (!r.fn && last && !last.fn && last.b === r.b && last.i === r.i) last.text += r.text;
    else merged.push({ ...r });
  }
  let out = '';
  for (const r of merged) {
    if (r.fn) { out = out.replace(/ $/, '') + `[^${r.fn}]`; continue; }
    let t = r.text.replace(/\s+/g, ' ');
    if (!out || out.endsWith(' ')) t = t.replace(/^ /, '');
    if (!t) continue;
    const core = t.trim();
    const lead = t.startsWith(' ') ? ' ' : '', trail = t.endsWith(' ') && core ? ' ' : '';
    const mk = r.b && r.i ? '***' : r.b ? '**' : r.i ? '*' : '';
    out += lead + (core ? mk + escapeMd(core) + mk : '') + trail;
  }
  return out.trim();
}

// XHTML-Dokument → Liste von { md } und { img, caption }
// notes: Map(Ziel-ID → Fußnotennummer)
function convertDoc(doc, docPath, notes) {
  const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
  return convertRoot(body, docPath, notes, { b: false, i: false }, 0);
}

// Inhalt eines Elements als eine Zeile Markdown (für Tabellenzellen und Fußnoten)
function inlineOf(el, docPath, notes, st) {
  return convertRoot(el, docPath, notes, st, 0).filter((x) => x.md).map((x) => x.md.replace(/^\\/, '')).join(' ');
}

function convertRoot(root, docPath, notes, rootStyle, rootLevel) {
  const out = [];
  let runs = [];
  let liPrefix = null;
  const flush = (prefix = '') => {
    const md = runsToMd(runs);
    runs = [];
    if (!md) return;
    const p = liPrefix != null ? liPrefix : prefix;
    liPrefix = null;
    // Absatz, der zufällig wie eine Auszeichnung beginnt, nicht falsch deuten
    let text = md;
    if (!p && /^(#{1,2} |[-•] |\d{1,3}[.)] |\|)/.test(text)) text = '\\' + text;
    out.push({ md: p + text });
  };
  const styleOf = (el, st) => {
    const tag = local(el);
    const css = (el.getAttribute && el.getAttribute('style')) || '';
    return {
      b: st.b || tag === 'b' || tag === 'strong' || /font-weight\s*:\s*(bold|[6-9]00)/i.test(css),
      i: st.i || tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn' || /font-style\s*:\s*(italic|oblique)/i.test(css),
    };
  };
  const imgSrc = (el) => {
    const tag = local(el);
    if (tag === 'img') return el.getAttribute('src');
    if (tag === 'image') return el.getAttribute('xlink:href') || el.getAttribute('href') || (el.getAttributeNS && el.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
    return null;
  };
  const walk = (node, st, level) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) { runs.push({ text: ch.data, ...st }); continue; }
      if (ch.nodeType !== 1) continue;
      const tag = local(ch);
      const et = epubType(ch);
      if (SKIP.has(tag)) continue;
      if (tag === 'nav' && /toc|landmarks|page-list/.test(et)) continue;
      if (tag === 'br') { runs.push({ text: ' ', ...st }); continue; }
      if (tag === 'img' || tag === 'image') {
        const src = imgSrc(ch);
        if (src) { flush(); out.push({ img: resolvePath(docPath, src), caption: (ch.getAttribute('alt') || '').trim() }); }
        continue;
      }
      if (tag === 'svg') { const im = ch.querySelector && ch.querySelector('image'); if (im) { flush(); out.push({ img: resolvePath(docPath, imgSrc(im)), caption: '' }); } continue; }
      if (tag === 'a' && /noteref/.test(et)) {
        const label = (ch.textContent || '').replace(/[[\]()\s]/g, '').slice(0, 8);
        if (label) { runs.push({ text: '', fn: label }); continue; }
      }
      if (/footnote|endnote|rearnote/.test(et) && !/noteref/.test(et)) {
        flush();
        const id = ch.getAttribute('id') || (ch.querySelector && ch.querySelector('[id]') && ch.querySelector('[id]').getAttribute('id'));
        let label = (id && notes.get(id)) || '';
        let md = inlineOf(ch, docPath, notes, st);
        const m = md.match(/^\[?(\d{1,4}|[*†‡])[\].)]?\s+/);
        if (!label && m) label = m[1];
        if (m && m[1] === label) md = md.slice(m[0].length);
        if (md) out.push({ md: label ? `[^${label}]: ${md}` : md });
        continue;
      }
      if (/^h[1-6]$/.test(tag)) { flush(); walk(ch, st, level); flush(tag === 'h1' ? '# ' : '## '); continue; }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        let n = +(ch.getAttribute('start') || 1);
        for (const li of [...ch.children]) {
          if (local(li) !== 'li') continue;
          liPrefix = '  '.repeat(Math.min(4, level)) + (tag === 'ol' ? `${n++}. ` : '- ');
          walk(li, st, level + 1);
          flush();
          liPrefix = null;
        }
        continue;
      }
      if (tag === 'table') {
        flush();
        const rows = [];
        let header = false;
        for (const tr of ch.querySelectorAll('tr')) {
          const cells = [...tr.children].filter((c) => /^t[hd]$/.test(local(c)));
          if (!cells.length) continue;
          if (!rows.length) header = cells.every((c) => local(c) === 'th') || local(tr.parentNode) === 'thead';
          rows.push(cells.map((c) => inlineOf(c, docPath, notes, st)));
        }
        if (rows.length) out.push({ md: tableMd(rows, header) });
        continue;
      }
      if (tag === 'figure') {
        flush();
        const cap = ch.querySelector('figcaption');
        const capText = cap ? (cap.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const im = ch.querySelector('img, image');
        if (im && imgSrc(im)) out.push({ img: resolvePath(docPath, imgSrc(im)), caption: capText || (im.getAttribute('alt') || '').trim() });
        for (const c of [...ch.children]) if (c !== cap && !(c.matches && c.matches('img, image')) && !(c.querySelector && c.querySelector('img, image'))) { walk(c, st, level); flush(); }
        continue;
      }
      if (tag === 'hr') { flush(); continue; }
      if (BLOCK.has(tag)) { flush(); walk(ch, styleOf(ch, st), level); flush(); continue; }
      walk(ch, styleOf(ch, st), level);
    }
  };
  walk(root, rootStyle, rootLevel);
  flush();
  return out;
}

async function toJpeg(blob, maxEdge = 1600) {
  const src = await loadBitmap(blob);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) try { src.close(); } catch (e) { /* */ }
  return { image: await toBlob(c, 'image/jpeg', 0.85), w: c.width, h: c.height, srcW: w, srcH: h };
}

export async function importEpub(file, { folderId = null, onProgress, signal } = {}) {
  const JSZip = await loadJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (e) { throw new Error('Die Datei ist kein gültiges EPUB'); }
  const read = async (path, type = 'string') => { const f = zip.file(path); return f ? f.async(type) : null; };

  // Kopierschutz?
  const enc = await read('META-INF/encryption.xml');
  if (enc) {
    const ed = parseXml(enc, 'application/xml');
    for (const el of ed.getElementsByTagName('*')) {
      if (local(el) !== 'encrypteddata') continue;
      const alg = [...el.getElementsByTagName('*')].find((x) => local(x) === 'encryptionmethod') || null;
      const ref = [...el.getElementsByTagName('*')].find((x) => local(x) === 'cipherreference');
      const uri = ref ? ref.getAttribute('URI') || '' : '';
      const a = alg ? alg.getAttribute('Algorithm') || '' : '';
      const fontObf = /obfuscation|fonts\.idpf|ns\.adobe\.com\/pdf\/enc#RC/i.test(a) && /\.(otf|ttf|woff2?)$/i.test(uri);
      if (!fontObf) throw new Error('Dieses EPUB ist kopiergeschützt (DRM) und lässt sich nicht importieren.');
    }
  }
  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('Die Datei ist kein gültiges EPUB');
  const rootfile = [...parseXml(container, 'application/xml').getElementsByTagName('*')].find((x) => local(x) === 'rootfile');
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  const opfText = opfPath && await read(opfPath);
  if (!opfText) throw new Error('Inhaltsverzeichnis des EPUB fehlt');
  const opf = parseXml(opfText, 'application/xml');
  const all = [...opf.getElementsByTagName('*')];
  const meta = (name) => { const el = all.find((x) => local(x) === name); return el ? (el.textContent || '').trim() : ''; };
  const title = meta('title') || baseName(file);
  const author = all.filter((x) => local(x) === 'creator').map((x) => (x.textContent || '').trim()).filter(Boolean).join(', ');
  let isbn = null;
  for (const el of all.filter((x) => local(x) === 'identifier')) { const v = normalizeIsbn((el.textContent || '').replace(/^urn:isbn:/i, '')); if (v) { isbn = v; break; } }
  const manifest = new Map();
  for (const it of all.filter((x) => local(x) === 'item')) {
    manifest.set(it.getAttribute('id'), { href: resolvePath(opfPath, it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  }
  let coverPath = null;
  for (const it of manifest.values()) if (/cover-image/.test(it.props)) coverPath = it.href;
  if (!coverPath) {
    const m = all.find((x) => local(x) === 'meta' && x.getAttribute('name') === 'cover');
    const it = m && manifest.get(m.getAttribute('content'));
    if (it && /^image\//.test(it.type)) coverPath = it.href;
  }
  const spine = all.filter((x) => local(x) === 'itemref' && x.getAttribute('linear') !== 'no')
    .map((x) => manifest.get(x.getAttribute('idref'))).filter((it) => it && /html|xml/.test(it.type) && !/\bnav\b/.test(it.props));
  if (!spine.length) throw new Error('Das EPUB enthält keinen Text');

  // Dokumente einlesen; Fußnotenverweise (Ziel → Nummer) im ganzen Buch sammeln
  const docs = [];
  const notes = new Map();
  for (const it of spine) {
    const text = await read(it.href);
    if (!text) continue;
    const doc = parseXml(text);
    for (const a of doc.getElementsByTagName('a')) {
      if (!/noteref/.test(epubType(a))) continue;
      const href = a.getAttribute('href') || '';
      const id = href.split('#')[1];
      const label = (a.textContent || '').replace(/[[\]()\s]/g, '').slice(0, 8);
      if (id && label) notes.set(id, label);
    }
    docs.push({ path: it.href, doc });
  }

  const book = await db.createBook({ title, author });
  const patch = { source: 'epub', ...(isbn ? { isbn } : {}), ...(folderId ? { folderId } : {}) };
  if (coverPath) {
    try { const b = await read(coverPath, 'blob'); if (b) patch.cover = await processCover(b); } catch (e) { console.warn('Cover', e); }
  }
  await db.updateBook(book.id, patch);

  const imgCache = new Map();
  let pages = 0, figures = 0;
  for (let d = 0; d < docs.length; d++) {
    if (signal && signal.aborted) break;
    const items = convertDoc(docs[d].doc, docs[d].path, notes).filter((x) => !(x.img && x.img === coverPath));
    // In Seiten zu ca. PAGE_CHARS Zeichen teilen (nicht mitten in einer Aufzählung)
    const chunks = [];
    let cur = [], size = 0;
    for (const it of items) {
      const len = it.md ? parseBlock(it.md).plain.length : 400;
      const isLi = it.md && /^\s*([-•]|\d{1,3}[.)]) /.test(it.md);
      if (cur.length && size + len > PAGE_CHARS && !isLi) { chunks.push(cur); cur = []; size = 0; }
      cur.push(it); size += len;
    }
    if (cur.length) chunks.push(cur);
    for (const chunk of chunks) {
      const mds = chunk.filter((x) => x.md);
      const figs = chunk.filter((x) => x.img);
      if (!mds.length && !figs.length) continue;
      const m = chunk.length;
      const paraY = [];
      chunk.forEach((x, k) => { if (x.md) paraY.push(r4((k + 0.5) / m)); });
      const page = await db.addPage(book.id, { text: mds.map((x) => x.md).join('\n\n'), paraY, ocrStatus: 'done', confidence: 100 });
      pages++;
      for (const [k, x] of chunk.entries()) {
        if (!x.img) continue;
        let img = imgCache.get(x.img);
        if (img === undefined) {
          try { const b = await read(x.img, 'blob'); img = b ? await toJpeg(b) : null; } catch (e) { console.warn('Bild', x.img, e); img = null; }
          imgCache.set(x.img, img);
        }
        if (!img || (img.srcW < 48 && img.srcH < 48)) continue; // Zierrat
        await db.addFigure({ bookId: book.id, pageId: page.id, image: img.image, rect: { x: 0, y: r4(k / m + 0.01 / m), w: 1, h: r4(0.9 / m) }, w: img.w, h: img.h, caption: x.caption || '', fullPage: false });
        figures++;
      }
    }
    onProgress && onProgress((d + 1) / docs.length, `Kapitel ${d + 1} von ${docs.length}`);
  }
  if (!pages) { await db.deleteBook(book.id); throw new Error('Im EPUB wurde kein Text gefunden'); }
  return { bookId: book.id, pages, figures };
}
