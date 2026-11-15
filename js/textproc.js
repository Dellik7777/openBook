// Aufbereitung des OCR-Ergebnisses zu fließendem Lesetext.

import { parseBlock, plainInline, styledWords, escapeMd } from './rich.js';

const HYPHENS = /[-­‐‑¬]$/;
const TERMINAL = /[.!?…:;"“”„»«'’)\]]$/;

// Eine Zeile an die bisherige Absatz-Zeichenkette anhängen, mit Silbentrennungs-Reparatur.
function joinLine(acc, line) {
  if (!acc) return line;
  if (HYPHENS.test(acc) && /^[a-zäöüß]/.test(line)) {
    // "Ver-" + "ständnis" → "Verständnis"
    return acc.replace(HYPHENS, '') + line;
  }
  if (HYPHENS.test(acc) && /^[A-ZÄÖÜ]/.test(line)) {
    // "Nord-" + "Süd" → "Nord-Süd" (Bindestrich bleibt)
    return acc.replace(/[­¬]$/, '-') + line;
  }
  return acc + ' ' + line;
}

function cleanLine(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

function isNoise(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t)) return true; // Seitenzahl
  if (/^[ivxlcdm]{1,6}$/i.test(t)) return true;           // römische Seitenzahl
  if (t.length <= 2 && !/[A-Za-zÄÖÜäöüß0-9]/.test(t)) return true;
  return false;
}

// Tesseract-Ergebnis (data) → Liste von Absätzen (Kurzform)
export function paragraphsFromOcr(data) {
  return analyzeOcr(data).paras;
}

const NUM_ONLY = /^[-–—.\s]*(\d{1,4})[-–—.\s]*$/;
const NUM_START = /^(\d{1,4})\s+\S/;
const NUM_END = /\S\s+(\d{1,4})$/;

// Gedruckte Seitenzahl finden: einzeln stehende Zahl oder Zahl in der Kopf-/Fußzeile,
// jeweils in der obersten oder untersten Zeile der Seite.
function findPageNumber(lines, height) {
  if (!lines.length) return null;
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
  const top = sorted[0].y0;
  const bottom = Math.max(...lines.map((l) => l.y1));
  const span = Math.max(1, bottom - top);
  const zone = Math.max(span * 0.06, height ? height * 0.04 : 0);
  const heights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 10;
  // Abstand zum Fließtext: Kopf-/Fußzeilen stehen deutlich abgesetzt
  const separated = (l, atTop, atBottom) => {
    const i = sorted.indexOf(l);
    const n = sorted[i + 1], p = sorted[i - 1];
    const below = !n || n.y0 - l.y1 > lineH * 0.6;
    const above = !p || l.y0 - p.y1 > lineH * 0.6;
    return (!atTop || below) && (!atBottom || above);
  };
  const cands = [];
  const edge = height ? height * 0.012 : 0;
  for (const l of lines) {
    // Am Bildrand abgeschnittene Zeilen (z. B. halb fotografierte Nachbarseite) ignorieren
    if (height && (l.y0 < edge || l.y1 > height - edge)) continue;
    const atTop = l.y0 <= top + zone;
    const atBottom = l.y1 >= bottom - zone;
    if (!atTop && !atBottom) continue;
    const t = l.text;
    let m;
    if ((m = t.match(NUM_ONLY))) cands.push({ line: l, n: +m[1], score: 3 + (l.conf || 0) / 100 });
    else if (t.length <= 70 && ((m = t.match(NUM_START)) || (m = t.match(NUM_END))) && separated(l, atTop, atBottom)) {
      cands.push({ line: l, n: +m[1], score: atTop ? 2 : 1, header: true });
    }
  }
  const valid = cands.filter((c) => c.n >= 1 && !(c.header && c.n >= 1500 && c.n <= 2100)); // keine Jahreszahlen
  valid.sort((a, b) => b.score - a.score);
  const c = valid[0];
  if (!c) return null;
  // Alle Zeilen mit dieser Seitenzahl (Kopf- UND Fußzeile) aus dem Text nehmen
  return { n: c.n, lines: valid.filter((x) => x.n === c.n).map((x) => x.line.ref) };
}

// Vollständige Auswertung: Absätze mit Struktur (Überschriften, Aufzählungen, fett/kursiv),
// Lage der Absätze auf der Seite (0..1) und gedruckte Seitenzahl.
// Kopf-/Fußzeile mit der Seitenzahl wird aus dem Lesetext entfernt.
// Wörter dürfen bold/italic tragen (siehe fontstyle.js) – dann wird **fett**/*kursiv* gesetzt.
export function analyzeOcr(data, { height = 0 } = {}) {
  const lines = collectLines(data);
  const H = height || Math.max(1, ...lines.map((l) => l.y1));
  const pn = findPageNumber(lines, height);
  const drop = new Set(pn ? pn.lines : []);
  // Am Bildrand abgeschnittene Zeilen sind unvollständig (Nachbarseite, Kopfzeile halb im Bild)
  const edge = height ? height * 0.012 : -1;
  const body = lines.filter((l) => !drop.has(l.ref) && !(height && (l.y0 < edge || l.y1 > height - edge)));

  if (!body.length) {
    if (!lines.length && data.text) {
      const plain = paragraphsFromPlain(data.text);
      return { paras: plain.map(escapeMd), paraY: plain.map((_, i) => (i + 0.5) / plain.length), printedNo: null };
    }
    return { paras: [], paraY: [], printedNo: pn ? pn.n : null };
  }

  const blocks = buildBlocks(body);
  const paras = [];
  for (const b of blocks) {
    const plain = plainInline(b.md).trim();
    if (!plain || isNoise(plain)) continue;
    if (b.conf < 35 && plain.length < 25) continue; // Bildrauschen, Fussel
    paras.push({ ...b, y: b.y / H });
  }
  const merged = mergeBroken(paras);
  return {
    paras: merged.map(blockToMd),
    paraY: merged.map((p) => Math.round(p.y * 1000) / 1000),
    printedNo: pn ? pn.n : null,
  };
}

function collectLines(data) {
  const lines = [];
  let paraId = 0, lineId = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      paraId++;
      for (const line of para.lines || []) {
        const text = cleanLine(line.text || '');
        if (!text || !line.bbox) continue;
        lineId++;
        let words = (line.words || []).filter((w) => w.text && w.text.trim() && w.bbox)
          .map((w) => ({ text: w.text.trim(), bbox: w.bbox, bold: !!w.bold, italic: !!w.italic, conf: w.confidence ?? 90 }));
        // Störzeichen (z. B. durchscheinende Rückseite): sehr unsicher erkannte, kurze Wörter am Zeilenende
        while (words.length > 1 && words[words.length - 1].conf < 35 && words[words.length - 1].text.length <= 2) words.pop();
        words = words.filter((w) => w.conf >= 20 || w.text.length > 3);
        if (!words.length) continue;
        const wh = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
        lines.push({
          text, words, wordH: wh[Math.floor(wh.length / 2)] || (line.bbox.y1 - line.bbox.y0),
          x0: line.bbox.x0, x1: line.bbox.x1, y0: line.bbox.y0, y1: line.bbox.y1,
          conf: line.confidence, paraId, lineId, ref: line,
        });
      }
    }
  }
  return lines;
}

// Aufzählungszeichen, wie die OCR sie liest (o, ©, ° für Kreise, ■ ▪ für Quadrate …)
const BULLET = /^([-–—•▪■□◦○●°·*o©¢»>=])$/;
const ORDERED = /^((?:\d{1,3}|[a-zA-Z])[.)])$/;

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function buildBlocks(lines) {
  const lineH = median(lines.map((l) => l.y1 - l.y0)) || 20;
  const wordH = median(lines.map((l) => l.wordH)) || lineH;
  const left = Math.min(...lines.map((l) => l.x0));
  const width = Math.max(1, Math.max(...lines.map((l) => l.x1)) - left);

  // 1) Aufzählungszeilen erkennen
  for (const l of lines) {
    const [w0, w1] = l.words;
    if (!w1) continue;
    const t = w0.text;
    const narrow = (w0.bbox.x1 - w0.bbox.x0) < lineH * 1.2;
    if (BULLET.test(t) && narrow && !(t === 'o' && /^[a-zäöüß]/.test(w1.text))) {
      l.bullet = { ordered: false, x: w0.bbox.x0, textX: w1.bbox.x0, skip: 1 };
    } else if (ORDERED.test(t) && (w1.bbox.x0 - w0.bbox.x1) > lineH * 0.25) {
      l.bullet = { ordered: true, x: w0.bbox.x0, textX: w1.bbox.x0, skip: 0, marker: t };
    }
  }
  // 2) Ebenen über die Einrückung der Aufzählungszeichen
  const xs = [...new Set(lines.filter((l) => l.bullet).map((l) => l.bullet.x))].sort((a, b) => a - b);
  const levels = [];
  for (const x of xs) {
    if (!levels.length || x - levels[levels.length - 1] > Math.max(lineH * 1.2, width * 0.025)) levels.push(x);
  }
  const levelOf = (x) => {
    let lv = 0;
    levels.forEach((lx, i) => { if (x >= lx - Math.max(lineH * 0.6, width * 0.012)) lv = i; });
    return lv;
  };
  // Liegt die erste Ebene deutlich rechts vom Textrand, ist sie trotzdem Ebene 0.

  // 3) Zeilen zu Blöcken zusammenfassen
  const blocks = [];
  let cur = null, prev = null;
  const push = () => { if (cur) blocks.push(cur); cur = null; };
  for (const l of lines) {
    const gap = prev ? l.y0 - prev.y1 : 0;
    const words = l.bullet ? l.words.slice(l.bullet.skip) : l.words;
    const md = styledWords(words);
    const conf = l.words.reduce((s, w) => s + (w.conf ?? 90), 0) / l.words.length;
    const allBold = words.every((w) => w.bold);
    if (l.bullet) {
      push();
      cur = { type: 'li', level: levelOf(l.bullet.x), ordered: l.bullet.ordered, mdParts: [md], textX: l.bullet.textX, y: l.y0, conf, nLines: 1, bold: allBold, h: l.wordH };
    } else if (cur && cur.type === 'li' && Math.abs(l.x0 - cur.textX) < lineH * 1.5 && gap < lineH * 1.1 && prev && prev.paraId === l.paraId) {
      cur.mdParts.push(md); cur.nLines++; cur.bold = cur.bold && allBold;
    } else if (cur && cur.type === 'li' && Math.abs(l.x0 - cur.textX) < lineH * 1.5 && gap < lineH * 0.8) {
      cur.mdParts.push(md); cur.nLines++; cur.bold = cur.bold && allBold;
    } else if (cur && cur.type === 'p' && prev && prev.paraId === l.paraId && gap < lineH * 0.9) {
      cur.mdParts.push(md); cur.nLines++; cur.bold = cur.bold && allBold;
    } else {
      push();
      cur = { type: 'p', level: 0, mdParts: [md], y: l.y0, conf, nLines: 1, bold: allBold, h: l.wordH, x0: l.x0 };
    }
    prev = l;
  }
  push();

  // 4) Überschriften: einzelne kurze Zeile, fett oder deutlich größer, ohne Satzzeichen am Ende
  blocks.forEach((b, i) => {
    b.md = b.mdParts.reduce((acc, part) => joinLine(acc, part), '');
    if (b.nLines !== 1) return;
    const plain = plainInline(b.md).trim();
    const words = plain.split(/\s+/).length;
    if (plain.length > 60 || words > 8 || /[.,;!?]$/.test(plain) || /^\d+$/.test(plain)) return;
    const big = b.h >= wordH * 1.3;
    // Fette Aufzählungspunkte der obersten Ebene mit Unterpunkten sind Abschnittsüberschriften
    const next = blocks[i + 1];
    const sectionItem = b.type === 'li' && !b.ordered && b.bold && next && next.type === 'li' && next.level > b.level;
    if ((b.type === 'p' && (big || b.bold)) || sectionItem) {
      b.fromList = b.type === 'li';
      b.type = b.h >= wordH * 1.6 ? 'h1' : 'h2';
      b.md = unbold(b.md); // fett ist bei Überschriften selbstverständlich
    }
  });
  // Einheitlich: Sind fette Hauptpunkte zu Überschriften geworden, gilt das für alle
  // kurzen fetten Hauptpunkte (auch ohne Unterpunkte)
  if (blocks.some((b) => (b.type === 'h1' || b.type === 'h2') && b.fromList)) {
    for (const b of blocks) {
      if (b.type !== 'li' || b.level !== 0 || !b.bold || b.nLines !== 1 || b.ordered) continue;
      const plain = plainInline(b.md).trim();
      if (plain.length > 60 || /[.,;!?]$/.test(plain)) continue;
      b.type = 'h2';
      b.md = unbold(b.md);
    }
  }
  // Unterpunkte einer zur Überschrift gewordenen Aufzählung rücken eine Ebene nach links
  let shift = 0;
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2') { shift = 1; continue; }
    if (b.type === 'li') b.level = Math.max(0, b.level - shift);
    else shift = 0;
  }
  return blocks;
}

function unbold(md) {
  return md.replace(/\*\*\*(.+?)\*\*\*/g, '*$1*').replace(/\*\*(.+?)\*\*/g, '$1');
}

function blockToMd(b) {
  if (b.type === 'h1') return '# ' + b.md;
  if (b.type === 'h2') return '## ' + b.md;
  if (b.type === 'li') {
    const ind = '  '.repeat(b.level);
    // nummerierte Punkte behalten ihre Nummer („1. …“), sonst Spiegelstrich
    return ind + (b.ordered ? '' : '- ') + b.md;
  }
  return b.md;
}

// Tesseract trennt Absätze manchmal mitten im Satz (z. B. bei kurzen Zeilen).
// Fortsetzung erkennen: Vorgänger ohne Satzende und Nachfolger beginnt klein
// oder Vorgänger endet mit Trennstrich/Komma.
function mergeBroken(paras) {
  const out = [];
  for (const p of paras) {
    const prev = out[out.length - 1];
    const pPlain = plainInline(p.md || p.text || '');
    const prevPlain = prev ? plainInline(prev.md || prev.text || '') : '';
    if (prev && prev.type === 'p' && (p.type || 'p') === 'p' && !TERMINAL.test(prevPlain)
        && (/^[a-zäöüß]/.test(pPlain) || /[-,\u00AD¬]$/.test(prevPlain))) {
      prev.md = joinLine(prev.md, p.md);
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

// Fallback: Text mit Leerzeilen als Absatzgrenzen
export function paragraphsFromPlain(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map(cleanLine).filter(Boolean).reduce(joinLine, ''))
    .map((p) => p.trim())
    .filter((p) => p && !isNoise(p));
}

export function splitParas(text) {
  if (!text) return [];
  // führende Leerzeichen bleiben erhalten (Einrückung von Aufzählungen)
  return text.split(/\n\s*\n/).map((p) => p.replace(/^\n+/, '').trimEnd()).filter((p) => p.trim());
}

const FIGURE_WEIGHT = 600; // eine Abbildung zählt für den Fortschritt wie ~600 Zeichen

// Baut den Lesefluss für ein ganzes Buch.
// pages: [{id, text, ocrStatus, paraY}], figuresByPage: Map(pageId → [figure])
// → [{ pageId, pageIndex, p, text, placeholder?, figure?, weight }]
// Absätze, die über eine Seitengrenze laufen, werden zusammengefügt.
// Abbildungen werden nach ihrer Lage auf der Seite zwischen die Absätze gesetzt.
// Kolumnentitel (wiederkehrende Kopf-/Fußzeilen wie Buch- oder Kapiteltitel) erkennen:
// kurze Zeilen ohne Satzende, die auf mehreren Seiten als erster/letzter Absatz stehen.
function runningHeaders(pages) {
  // Ziffern zählen mit: „Kapitel 1“ und „Kapitel 2“ sind verschiedene Überschriften, kein Kolumnentitel
  const norm = (t) => t.toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ').trim();
  const count = new Map();
  for (const page of pages) {
    const paras = splitParas(page.text).map((m) => parseBlock(m).plain);
    const cands = new Set([paras[0], paras[paras.length - 1]].filter((t) => t && t.length <= 60 && !/[.!?:,;]$/.test(t)).map(norm).filter(Boolean));
    for (const c of cands) count.set(c, (count.get(c) || 0) + 1);
  }
  const min = pages.length >= 6 ? 3 : 2;
  const set = new Set([...count].filter(([, n]) => n >= min).map(([k]) => k));
  return (t) => t.length <= 60 && set.has(norm(t));
}

const CAPTION = /^(abb\.?|abbildung|fig\.?|figur|karte|tabelle|tab\.|grafik|diagramm|bild)\s*\d*[a-z]?\s*[:.–-]/i;

export function buildFlow(pages, figuresByPage = new Map()) {
  const flow = [];
  const isHeader = runningHeaders(pages);
  let lastText = null; // letzter Textabsatz (für Fortsetzungen über Seitengrenzen)
  pages.forEach((page, pageIndex) => {
    const all = splitParas(page.text);
    const allY = Array.isArray(page.paraY) && page.paraY.length === all.length ? page.paraY : null;
    // Kolumnentitel nur am Seitenanfang/-ende entfernen
    const parsed = all.map(parseBlock);
    const keep = parsed.map((b, i) => !((i === 0 || i === all.length - 1) && b.type !== 'li' && isHeader(b.plain)));
    const paras = parsed.filter((_, i) => keep[i]);
    if (allY) page = { ...page, paraY: allY.filter((_, i) => keep[i]) };
    const figs = [...(figuresByPage.get(page.id) || [])].sort((a, b) => (a.rect?.y || 0) - (b.rect?.y || 0));
    let lastFig = null;
    const pushFigure = (f) => { lastFig = { pageId: page.id, pageIndex, p: 'f:' + f.id, figure: f, caption: f.caption || '', text: f.caption || '', weight: FIGURE_WEIGHT }; flow.push(lastFig); };
    if (!paras.length) {
      figs.forEach(pushFigure);
      if (figs.length && page.ocrStatus === 'done') return;
      flow.push({
        pageId: page.id,
        pageIndex,
        p: 0,
        placeholder: true,
        text: page.ocrStatus === 'done'
          ? `Seite ${pageIndex + 1} enthält keinen erkannten Text.`
          : page.ocrStatus === 'error'
            ? `Seite ${pageIndex + 1} konnte nicht erkannt werden.`
            : `Seite ${pageIndex + 1} wird noch erkannt …`,
      });
      lastText = null;
      return;
    }
    const ys = Array.isArray(page.paraY) && page.paraY.length === paras.length
      ? page.paraY
      : paras.map((_, i) => (i + 0.5) / paras.length);
    let fi = 0;
    paras.forEach((blk, p) => {
      const text = blk.plain;
      // Abbildungen, die oberhalb dieses Absatzes liegen
      while (fi < figs.length && (figs[fi].rect?.y || 0) < ys[p]) pushFigure(figs[fi++]);
      // Gedruckte Bildunterschrift direkt unter der Abbildung → als Bildunterschrift übernehmen
      if (lastFig && flow[flow.length - 1] === lastFig && text.length < 220 && CAPTION.test(text)) {
        if (!lastFig.caption) lastFig.caption = lastFig.text = text;
        return;
      }
      lastFig = null;
      if (p === 0 && lastText && blk.type === 'p' && lastText.block === 'p' && !TERMINAL.test(lastText.text)) {
        // Fortsetzung des Absatzes von der Vorseite
        lastText.md = joinLine(lastText.md, blk.md);
        lastText.text = joinLine(lastText.text, text);
        lastText.continues = lastText.continues || [];
        // offset = Zeichenposition, an der die neue Seite im Absatz beginnt
        lastText.continues.push({ pageId: page.id, pageIndex, offset: lastText.text.length - text.length });
        return;
      }
      lastText = { pageId: page.id, pageIndex, p, text, md: blk.md, block: blk.type, level: blk.level, ordered: !!blk.ordered, label: blk.label };
      flow.push(lastText);
    });
    while (fi < figs.length) pushFigure(figs[fi++]);
  });
  for (const f of flow) if (!f.weight) f.weight = f.text.length + 1;
  return flow;
}
