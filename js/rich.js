// Leichtgewichtige Auszeichnung für erkannten Text (Markdown-Teilmenge).
// Ein Block pro Absatz (getrennt durch Leerzeile):
//   # Überschrift            ## Unterüberschrift
//   - Aufzählung             (2 Leerzeichen Einrückung je Ebene)
//   1. nummeriert / a) …     (Nummer bleibt Teil des Texts)
//   Absatz
// Innerhalb: **fett**, *kursiv*, ***fett+kursiv***, \* für ein echtes Sternchen.

const BLOCK_LI = /^( *)[-•] +(.*)$/s;
const BLOCK_OL = /^( *)((?:\d{1,3}|[a-zA-Z])[.)]) +(.*)$/s;
const BLOCK_H = /^(#{1,2}) +(.*)$/s;

export function parseBlock(md) {
  let m;
  if ((m = md.match(BLOCK_H))) {
    const inner = m[2];
    return { type: m[1].length === 1 ? 'h1' : 'h2', level: 0, md: inner, plain: plainInline(inner) };
  }
  if ((m = md.match(BLOCK_LI))) {
    const inner = m[2];
    return { type: 'li', level: Math.min(4, Math.floor(m[1].length / 2)), md: inner, plain: plainInline(inner) };
  }
  if ((m = md.match(BLOCK_OL)) && (m[1].length > 0 || /^\d{1,3}\.$|^[a-z]\)$/.test(m[2]))) {
    // nummerierte Punkte; Nummer bleibt im Text
    const inner = m[2] + ' ' + m[3];
    return { type: 'li', ordered: true, level: Math.min(4, Math.floor(m[1].length / 2)), md: inner, plain: plainInline(inner) };
  }
  return { type: 'p', level: 0, md, plain: plainInline(md) };
}

// Zeichenfolge → [{ text, b, i }]
export function inlineTokens(md) {
  const out = [];
  let b = false, it = false, buf = '';
  const flush = () => { if (buf) { out.push({ text: buf, b, i: it }); buf = ''; } };
  for (let k = 0; k < md.length; k++) {
    const ch = md[k];
    if (ch === '\\' && md[k + 1] === '*') { buf += '*'; k++; continue; }
    if (ch === '*') {
      let n = 1;
      while (md[k + n] === '*') n++;
      // Nur als Auszeichnung werten, wenn es eine passende Gegenseite gibt
      flush();
      if (n >= 3) { b = !b; it = !it; } else if (n === 2) b = !b; else it = !it;
      k += n - 1;
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

export function plainInline(md) {
  return inlineTokens(md).map((t) => t.text).join('');
}

export function renderInline(md) {
  const frag = document.createDocumentFragment();
  for (const t of inlineTokens(md)) {
    let node = document.createTextNode(t.text);
    if (t.i) { const e = document.createElement('em'); e.append(node); node = e; }
    if (t.b) { const e = document.createElement('strong'); e.append(node); node = e; }
    frag.append(node);
  }
  return frag;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inlineXhtml(md) {
  return inlineTokens(md).map((t) => {
    let s = esc(t.text);
    if (t.i) s = `<i>${s}</i>`;
    if (t.b) s = `<b>${s}</b>`;
    return s;
  }).join('');
}

export function escapeMd(text) {
  return text.replace(/\*/g, '\\*');
}

// Wörter mit Stil → Inline-Markdown (zusammenhängende Läufe gleicher Formatierung)
export function styledWords(words) {
  let out = '';
  let cur = null;
  const close = () => { if (cur) out += cur.b && cur.i ? '***' : cur.b ? '**' : cur.i ? '*' : ''; };
  words.forEach((w, idx) => {
    const st = { b: !!w.bold, i: !!w.italic };
    const same = cur && cur.b === st.b && cur.i === st.i;
    if (!same) {
      close();
      if (idx) out += ' ';
      out += st.b && st.i ? '***' : st.b ? '**' : st.i ? '*' : '';
      cur = st;
    } else {
      out += ' ';
    }
    out += escapeMd(w.text);
  });
  close();
  return out;
}

// Markdown-Struktur ganz entfernen (z. B. für Export als reiner Text)
export function stripMd(md) {
  return md.split(/\n{2,}/).map((b) => parseBlock(b).plain).join('\n\n');
}
