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

// Tesseract-Ergebnis (data) → Liste von Absätzen
export function paragraphsFromOcr(data) {
  const paras = [];
  const blocks = data.blocks || [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      let acc = '';
      const conf = para.confidence ?? 100;
      for (const line of para.lines || []) {
        const lt = cleanLine(line.text || '');
        if (!lt) continue;
        acc = joinLine(acc, lt);
      }
      acc = acc.trim();
      if (!acc || isNoise(acc)) continue;
      if (conf < 35 && acc.length < 25) continue; // Bildrauschen, Fussel
      paras.push(acc);
    }
  }
  if (!paras.length && data.text) {
    return paragraphsFromPlain(data.text);
  }
  return mergeBroken(paras);
}

// Tesseract trennt Absätze manchmal mitten im Satz (z. B. bei kurzen Zeilen).
// Fortsetzung erkennen: Vorgänger ohne Satzende und Nachfolger beginnt klein
// oder Vorgänger endet mit Trennstrich/Komma.
function mergeBroken(paras) {
  const out = [];
  for (const p of paras) {
    const prev = out[out.length - 1];
    if (prev && !TERMINAL.test(prev) && (/^[a-zäöüß]/.test(p) || /[-,\u00AD¬]$/.test(prev))) {
      out[out.length - 1] = joinLine(prev, p);
    } else {
      out.push(p);
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

// Baut den Lesefluss für ein ganzes Buch.
// pages: [{id, text, ocrStatus}] → [{ pageId, pageIndex, p, text, placeholder? }]
// Absätze, die über eine Seitengrenze laufen, werden zusammengefügt.
export function buildFlow(pages) {
  const flow = [];
  pages.forEach((page, pageIndex) => {
    const paras = splitParas(page.text);
    if (!paras.length) {
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
      return;
    }
    paras.forEach((text, p) => {
      const prev = flow[flow.length - 1];
      if (p === 0 && prev && !prev.placeholder && !TERMINAL.test(prev.text)) {
        // Fortsetzung des Absatzes von der Vorseite
        prev.text = joinLine(prev.text, text);
        prev.continues = prev.continues || [];
        // offset = Zeichenposition, an der die neue Seite im Absatz beginnt
        prev.continues.push({ pageId: page.id, pageIndex, offset: prev.text.length - text.length });
        return;
      }
      flow.push({ pageId: page.id, pageIndex, p, text });
    });
  });
  return flow;
}
