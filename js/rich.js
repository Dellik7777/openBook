// Leichtgewichtige Auszeichnung für erkannten Text (Markdown-Teilmenge).
// Ein Block pro Absatz (getrennt durch Leerzeile):
//   # Überschrift            ## Unterüberschrift
//   - Aufzählung             (2 Leerzeichen Einrückung je Ebene)
//   1. nummeriert / a) …     (Nummer bleibt Teil des Texts)
//   Absatz
//   | Zelle | Zelle |          Tabelle (jede Zeile beginnt mit |; |---| nach der Kopfzeile)
//   [^3]: Fußnotentext       Fußnote
// Innerhalb: **fett**, *kursiv*, ***fett+kursiv***, \* für ein echtes Sternchen,
// [^3] Verweis auf eine Fußnote.

const BLOCK_LI = /^( *)[-•] +(.*)$/s;
const BLOCK_OL = /^( *)((?:\d{1,3}|[a-zA-Z])[.)]) +(.*)$/s;
const BLOCK_H = /^(#{1,2}) +(.*)$/s;
const BLOCK_FN = /^\[\^([\w*†‡-]{1,8})\]: *(.*)$/s;
const SEP_ROW = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Tabellenzeile „| a | b |“ → Zellen (\| ist ein echter Strich)
export function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
    if (t[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[k];
  }
  cells.push(cur.trim());
  return cells;
}

export function isTableBlock(md) {
  const lines = md.split('\n').filter((l) => l.trim());
  return lines.length >= 1 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l)) && lines.some((l) => !SEP_ROW.test(l));
}

// Klartext einer Tabelle (Zellen mit Leerzeichen getrennt) – entspricht dem Text der Darstellung
export function tablePlain(rows) {
  return rows.map((r) => r.map((c) => plainInline(c) + ' ').join('')).join('');
}

export function parseBlock(md) {
  let m;
  if (isTableBlock(md)) {
    const lines = md.split('\n').filter((l) => l.trim());
    const header = lines.length > 1 && SEP_ROW.test(lines[1]);
    const rows = lines.filter((l) => !SEP_ROW.test(l)).map(splitRow);
    return { type: 'table', level: 0, md, rows, header, plain: tablePlain(rows) };
  }
  if ((m = md.match(BLOCK_FN))) {
    const inner = m[2];
    return { type: 'fn', level: 0, label: m[1], md: inner, plain: m[1] + ' ' + plainInline(inner) };
  }
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
    // \ vor Sonderzeichen: Zeichen wörtlich nehmen (z. B. Absatz, der mit „1. “ oder „- “ beginnt)
    if (ch === '\\' && /[*|[#\-•\d]/.test(md[k + 1] || '')) { buf += md[k + 1]; k++; continue; }
    if (ch === '[' && md[k + 1] === '^') {
      const m = md.slice(k).match(/^\[\^([\w*†‡-]{1,8})\]/);
      if (m) { flush(); out.push({ text: '', fn: m[1], b, i: it }); k += m[0].length - 1; continue; }
    }
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
    if (t.fn) {
      // Verweis: Knopf (zählt nicht zum Lesetext, damit Positionen stimmen)
      const sup = document.createElement('sup');
      const b = document.createElement('button');
      b.className = 'fnref';
      b.type = 'button';
      b.dataset.fn = t.fn;
      b.setAttribute('aria-label', 'Fußnote ' + t.fn);
      b.textContent = t.fn;
      sup.append(b);
      frag.append(sup);
      continue;
    }
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
    if (t.fn) return `<sup>${esc(t.fn)}</sup>`;
    let s = esc(t.text);
    if (t.i) s = `<i>${s}</i>`;
    if (t.b) s = `<b>${s}</b>`;
    return s;
  }).join('');
}

export function escapeMd(text) {
  return text.replace(/\*/g, '\\*').replace(/\[\^/g, '\\[^');
}

// Tabelle als DOM (für Leser und Editor-Vorschau)
export function renderTable(blk) {
  const table = document.createElement('table');
  blk.rows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement(blk.header && ri === 0 ? 'th' : 'td');
      td.append(renderInline(cell), document.createTextNode(' '));
      tr.append(td);
    }
    table.append(tr);
  });
  return table;
}

export function tableXhtml(blk) {
  return '<table>' + blk.rows.map((row, ri) => '<tr>' + row.map((c) => {
    const tag = blk.header && ri === 0 ? 'th' : 'td';
    return `<${tag}>${inlineXhtml(c)}</${tag}>`;
  }).join('') + '</tr>').join('') + '</table>';
}

// Zeilen → Tabellen-Markdown
export function tableMd(rows, header = true) {
  const cell = (c) => String(c).replace(/\|/g, '\\|');
  const out = rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |');
  if (header && rows.length > 1) out.splice(1, 0, '|' + rows[0].map(() => '---').join('|') + '|');
  return out.join('\n');
}

// Wörter mit Stil → Inline-Markdown (zusammenhängende Läufe gleicher Formatierung)
export function styledWords(words) {
  let out = '';
  let cur = null;
  const close = () => {
    if (!cur) return;
    const mk = cur.b && cur.i ? '***' : cur.b ? '**' : cur.i ? '*' : '';
    if (!mk) return;
    // Satzzeichen am Ende gehören nicht zur Auszeichnung: „*Wort*.“ statt „*Wort.*“
    const m = out.match(/([.,;:!?…)\]»“”"']+)$/);
    if (m && !out.slice(0, -m[1].length).endsWith(mk)) out = out.slice(0, -m[1].length) + mk + m[1];
    else out += mk;
  };
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
  return md.split(/\n{2,}/).map((b) => {
    const blk = parseBlock(b);
    return blk.type === 'table' ? blk.rows.map((r) => r.map(plainInline).join('\t')).join('\n') : blk.plain;
  }).join('\n\n');
}
