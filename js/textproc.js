// Aufbereitung des OCR-Ergebnisses zu fließendem Lesetext.

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
  for (const l of lines) {
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

// Vollständige Auswertung: Absätze, Lage der Absätze auf der Seite (0..1), gedruckte Seitenzahl.
// Kopf-/Fußzeile mit der Seitenzahl wird aus dem Lesetext entfernt.
export function analyzeOcr(data, { height = 0 } = {}) {
  const blocks = data.blocks || [];
  const lines = [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = cleanLine(line.text || '');
        if (!text || !line.bbox) continue;
        lines.push({ text, y0: line.bbox.y0, y1: line.bbox.y1, conf: line.confidence, ref: line });
      }
    }
  }
  const H = height || Math.max(1, ...lines.map((l) => l.y1));
  const pn = findPageNumber(lines, height);
  const drop = new Set(pn ? pn.lines : []);

  const paras = [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      let acc = '';
      let y = null;
      const conf = para.confidence ?? 100;
      for (const line of para.lines || []) {
        if (drop.has(line)) continue;
        const lt = cleanLine(line.text || '');
        if (!lt) continue;
        if (y == null && line.bbox) y = line.bbox.y0 / H;
        acc = joinLine(acc, lt);
      }
      acc = acc.trim();
      if (!acc || isNoise(acc)) continue;
      if (conf < 35 && acc.length < 25) continue; // Bildrauschen, Fussel
      paras.push({ text: acc, y: y ?? 0 });
    }
  }
  if (!paras.length && data.text && !lines.length) {
    const plain = paragraphsFromPlain(data.text);
    return { paras: plain, paraY: plain.map((_, i) => (i + 0.5) / plain.length), printedNo: null };
  }
  const merged = mergeBroken(paras);
  return {
    paras: merged.map((p) => p.text),
    paraY: merged.map((p) => Math.round(p.y * 1000) / 1000),
    printedNo: pn ? pn.n : null,
  };
}

// Tesseract trennt Absätze manchmal mitten im Satz (z. B. bei kurzen Zeilen).
// Fortsetzung erkennen: Vorgänger ohne Satzende und Nachfolger beginnt klein
// oder Vorgänger endet mit Trennstrich/Komma.
function mergeBroken(paras) {
  const out = [];
  for (const p of paras) {
    const prev = out[out.length - 1];
    if (prev && !TERMINAL.test(prev.text) && (/^[a-zäöüß]/.test(p.text) || /[-,\u00AD¬]$/.test(prev.text))) {
      prev.text = joinLine(prev.text, p.text);
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
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
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
  const norm = (t) => t.toLowerCase().replace(/[^a-zäöüß]+/g, ' ').trim();
  const count = new Map();
  for (const page of pages) {
    const paras = splitParas(page.text);
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
    const keep = all.map((t, i) => !((i === 0 || i === all.length - 1) && isHeader(t)));
    const paras = all.filter((_, i) => keep[i]);
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
    paras.forEach((text, p) => {
      // Abbildungen, die oberhalb dieses Absatzes liegen
      while (fi < figs.length && (figs[fi].rect?.y || 0) < ys[p]) pushFigure(figs[fi++]);
      // Gedruckte Bildunterschrift direkt unter der Abbildung → als Bildunterschrift übernehmen
      if (lastFig && flow[flow.length - 1] === lastFig && text.length < 220 && CAPTION.test(text)) {
        if (!lastFig.caption) lastFig.caption = lastFig.text = text;
        return;
      }
      lastFig = null;
      if (p === 0 && lastText && !TERMINAL.test(lastText.text)) {
        // Fortsetzung des Absatzes von der Vorseite
        lastText.text = joinLine(lastText.text, text);
        lastText.continues = lastText.continues || [];
        // offset = Zeichenposition, an der die neue Seite im Absatz beginnt
        lastText.continues.push({ pageId: page.id, pageIndex, offset: lastText.text.length - text.length });
        return;
      }
      lastText = { pageId: page.id, pageIndex, p, text };
      flow.push(lastText);
    });
    while (fi < figs.length) pushFigure(figs[fi++]);
  });
  for (const f of flow) if (!f.weight) f.weight = f.text.length + 1;
  return flow;
}
