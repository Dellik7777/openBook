// EAN-13-Strichcodes (ISBN) aus einem Graustufenbild lesen – ohne fremde Bibliothek,
// damit es auch in Safari (kein BarcodeDetector) funktioniert.
//
// Vorgehen: mehrere Bildzeilen abtasten, je Zeile mit gleitendem Mittelwert binarisieren,
// Lauflängen bilden und darin die 59 Läufe eines EAN-13-Codes suchen
// (Randzeichen, 6 Ziffern, Mittelzeichen, 6 Ziffern, Randzeichen).

// Breiten der vier Läufe je Ziffer (L- und R-Code haben dieselben Breiten, G ist gespiegelt)
const L = [[3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2], [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2]];
const G = L.map((p) => [...p].reverse());
// Parität der linken Hälfte (0 = L, 1 = G) → erste Ziffer
const PARITY = ['000000', '001011', '001101', '001110', '010011', '011001', '011100', '010101', '010110', '011010'];

function matchDigit(runs, table) {
  const sum = runs[0] + runs[1] + runs[2] + runs[3];
  let best = -1, bestErr = Infinity, second = Infinity;
  for (let d = 0; d < 10; d++) {
    const p = table[d];
    let err = 0;
    for (let k = 0; k < 4; k++) err += Math.abs((runs[k] * 7) / sum - p[k]);
    if (err < bestErr) { second = bestErr; bestErr = err; best = d; } else if (err < second) second = err;
  }
  return { d: best, err: bestErr, margin: second - bestErr };
}

export function checksumOk(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let s = 0;
  for (let i = 0; i < 12; i++) s += +code[i] * (i % 2 ? 3 : 1);
  return (10 - (s % 10)) % 10 === +code[12];
}

// runs: Lauflängen, beginnend mit einem dunklen Lauf an Index start
function decodeAt(runs, start) {
  if (start + 59 > runs.length) return null;
  const seg = runs.slice(start, start + 59);
  const total = seg.reduce((a, b) => a + b, 0);
  const m = total / 95;
  // Ruhezone links (heller Lauf davor) sollte breit genug sein
  if (start > 0 && runs[start - 1] < m * 4) return null;
  const guard = (a, n) => { for (let k = 0; k < n; k++) if (Math.abs(seg[a + k] / m - 1) > 0.8) return false; return true; };
  if (!guard(0, 3) || !guard(27, 5) || !guard(56, 3)) return null;
  let digits = '', parity = '', err = 0;
  for (let i = 0; i < 6; i++) {
    const r = seg.slice(3 + i * 4, 7 + i * 4);
    const a = matchDigit(r, L), b = matchDigit(r, G);
    const x = a.err <= b.err ? a : b;
    if (x.err > 1.6) return null;
    digits += x.d; parity += a.err <= b.err ? '0' : '1'; err += x.err;
  }
  const first = PARITY.indexOf(parity);
  if (first < 0) return null;
  for (let i = 0; i < 6; i++) {
    const x = matchDigit(seg.slice(32 + i * 4, 36 + i * 4), L);
    if (x.err > 1.6) return null;
    digits += x.d; err += x.err;
  }
  const code = first + digits;
  return checksumOk(code) ? { code, err } : null;
}

function rowRuns(row, w) {
  // gleitender Mittelwert als Schwelle (robust gegen Helligkeitsverlauf)
  const win = Math.max(8, Math.round(w / 12));
  const pre = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + row[x];
  let mn = 255, mx = 0;
  for (let x = 0; x < w; x++) { if (row[x] < mn) mn = row[x]; if (row[x] > mx) mx = row[x]; }
  if (mx - mn < 40) return null;
  const runs = [];
  const dark = [];
  let cur = null, len = 0;
  for (let x = 0; x < w; x++) {
    const a = Math.max(0, x - win), b = Math.min(w, x + win + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    const thr = Math.min(mean - 4, (mn + mx) / 2 + (mx - mn) * 0.15);
    const d = row[x] < thr;
    if (d === cur) len++;
    else { if (cur !== null) { runs.push(len); dark.push(cur); } cur = d; len = 1; }
  }
  runs.push(len); dark.push(cur);
  return { runs, dark };
}

function scanRow(row, w) {
  const rr = rowRuns(row, w);
  if (!rr) return null;
  const { runs, dark } = rr;
  for (let i = 0; i + 59 <= runs.length; i++) {
    if (!dark[i]) continue;
    const r = decodeAt(runs, i);
    if (r) return r.code;
  }
  return null;
}

// gray: Uint8Array (w*h). Liefert die EAN-13-Ziffern oder null.
// Tastet waagerecht ab; mit vertical=true zusätzlich senkrecht (Buch quer gehalten).
export function decodeEan13(gray, w, h, { vertical = true } = {}) {
  const votes = new Map();
  const tryLine = (line, n) => {
    let code = scanRow(line, n);
    if (!code) { const rev = Uint8Array.from(line).reverse(); code = scanRow(rev, n); }
    if (code) votes.set(code, (votes.get(code) || 0) + 1);
  };
  const steps = 24;
  for (let k = 0; k < steps; k++) {
    const y = Math.round(h * (0.15 + 0.7 * k / (steps - 1)));
    tryLine(gray.subarray(y * w, y * w + w), w);
  }
  if (vertical) {
    const col = new Uint8Array(h);
    for (let k = 0; k < steps; k++) {
      const x = Math.round(w * (0.15 + 0.7 * k / (steps - 1)));
      for (let y = 0; y < h; y++) col[y] = gray[y * w + x];
      tryLine(col, h);
    }
  }
  let best = null, n = 0;
  for (const [c, v] of votes) if (v > n) { best = c; n = v; }
  return best;
}

export function grayFromCanvas(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

// ISBN-10 → ISBN-13; Eingaben mit Bindestrichen/Leerzeichen erlaubt. Ungültig → null
export function normalizeIsbn(s) {
  const t = String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (t.length === 13 && checksumOk(t)) return t;
  if (t.length === 10) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const v = t[i] === 'X' ? 10 : +t[i];
      if (t[i] === 'X' && i !== 9) return null;
      sum += v * (10 - i);
    }
    if (sum % 11) return null;
    const base = '978' + t.slice(0, 9);
    let s2 = 0;
    for (let i = 0; i < 12; i++) s2 += +base[i] * (i % 2 ? 3 : 1);
    return base + ((10 - (s2 % 10)) % 10);
  }
  return null;
}

export const isIsbn = (code) => /^97[89]\d{10}$/.test(code || '') && checksumOk(code);
