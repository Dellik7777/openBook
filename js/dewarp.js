// Gewölbte Textzeilen gerade ziehen (Buchseiten wölben sich zur Bindung hin).
//
// 1) Graustufen, lokal binarisiert, Zeilenabstand über die Autokorrelation der Zeilenprofile
// 2) Waagerechtes „Verschmieren“ (RLSA) → jede Textzeile wird ein zusammenhängender Streifen
// 3) Für jeden Streifen die Mittellinie messen und eine Parabel anpassen
// 4) Verschiebungsfeld: jede Zeile auf ihre mittlere Höhe ziehen, dazwischen interpolieren
// 5) Bild spaltenweise verschieben (nur senkrecht)
// Ohne genug sichere Zeilen oder ohne nennenswerte Wölbung bleibt das Bild unverändert.

const ANALYSIS_W = 1000;

function grayOf(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

// dunkel = Text (lokaler Mittelwert, Fenster ~ 1/30 der Breite)
function binarize(g, w, h) {
  const r = Math.max(8, Math.round(w / 30));
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row; }
  }
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      const mean = s / ((x1 - x0) * (y1 - y0));
      b[y * w + x] = g[y * w + x] < mean * 0.82 && g[y * w + x] < 200 ? 1 : 0;
    }
  }
  return b;
}

// Zusammenhängende dunkle Flächen (Buchstaben) → { lab, comps: [{id,x0,x1,y0,y1,n}] }
function components(b, w, h) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!b[i] || lab[i]) continue;
    const id = comps.length + 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && b[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && b[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && b[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && b[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    comps.push({ id, x0, x1, y0, y1, n });
  }
  return { lab, comps };
}

// Nur Schrift behalten: Papierkörnung (winzige Punkte) und große dunkle Flächen
// (Tisch, Schatten, Bilder) entfernen. → { b, mh (typische Buchstabenhöhe), letters }
function textOnly(b, w, h) {
  const { lab, comps } = components(b, w, h);
  const cand = comps.filter((c) => c.n >= 6 && c.y1 - c.y0 >= 3 && c.y1 - c.y0 < h * 0.08 && c.x1 - c.x0 < w * 0.25);
  if (cand.length < 25) return null;
  const hs = cand.map((c) => c.y1 - c.y0 + 1).sort((a, b2) => a - b2);
  const mh = hs[Math.floor(hs.length / 2)];
  // Buchstaben: nicht viel größer als üblich (Initialen bis 5×), nicht zu flach/fleckig
  const letters = cand.filter((c) => c.y1 - c.y0 + 1 <= mh * 5 && c.y1 - c.y0 + 1 >= mh * 0.35);
  const keep = new Uint8Array(comps.length + 1);
  for (const c of letters) keep[c.id] = 1;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (lab[i] && keep[lab[i]]) out[i] = 1;
  return { b: out, mh, letters };
}

// Zeilenabstand: Periode des Zeilenprofils (Autokorrelation), gesucht zwischen 1,3× und 6×
// der Buchstabenhöhe (sonst gewinnt die Papierkörnung)
function linePeriod(b, w, h, mh = 0) {
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += b[y * w + x]; prof[y] = s; }
  let mean = 0;
  for (const v of prof) mean += v;
  mean /= h;
  let best = 0, bestP = 0;
  const pMin = mh ? Math.max(3, Math.round(mh * 1.3)) : Math.round(h / 200);
  const pMax = mh ? Math.min(h / 3, mh * 6) : h / 8;
  const sc = [];
  for (let p = pMin; p < pMax; p++) {
    let s = 0;
    for (let y = 0; y + p < h; y++) s += (prof[y] - mean) * (prof[y + p] - mean);
    sc.push([p, s / (h - p)]);
  }
  for (const [p, v] of sc) if (v > best) { best = v; bestP = p; }
  // Grundperiode statt Vielfachem: kleinstes lokales Maximum mit ≥ 70 % des besten Werts
  for (let i = 1; i < sc.length - 1; i++) {
    const [p, v] = sc[i];
    if (v >= best * 0.7 && v >= sc[i - 1][1] && v >= sc[i + 1][1]) { bestP = p; break; }
  }
  return bestP;
}

function fitQuad(xs, ys) {
  // Kleinste Quadrate y = a + b x + c x²
  let n = xs.length, sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2; sy += y; sxy += x * y; sx2y += x2 * y;
  }
  const m = [[n, sx, sx2, sy], [sx, sx2, sx3, sxy], [sx2, sx3, sx4, sx2y]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// Analyse → { lines: [{fit, x0, x1, t}], L } oder null
export function analyzeLines(src, srcW, srcH) {
  const s = Math.min(1, ANALYSIS_W / srcW);
  const w = Math.max(50, Math.round(srcW * s)), h = Math.max(50, Math.round(srcH * s));
  const t = textOnly(binarize(grayOf(src, w, h), w, h), w, h);
  if (!t) return null;
  const b = t.b;
  const L = linePeriod(b, w, h, t.mh);
  if (!L || L < 6) return null;
  // Waagerecht verschmieren: Lücken bis ~0,9 Zeilenabstand schließen (Wortabstände)
  const gap = Math.round(L * 0.9);
  const sm = new Uint8Array(b);
  for (let y = 0; y < h; y++) {
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (!b[y * w + x]) continue;
      if (last >= 0 && x - last > 1 && x - last <= gap) for (let k = last + 1; k < x; k++) sm[y * w + k] = 1;
      last = x;
    }
  }
  // Zusammenhängende Streifen (4er-Nachbarschaft)
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!sm[i] || lab[i]) continue;
    const id = comps.length + 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && sm[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && sm[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && sm[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && sm[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    comps.push({ id, x0, x1, y0, y1, n });
  }
  const textW = Math.max(1, Math.max(0, ...comps.filter((c) => c.x1 - c.x0 > L * 3).map((c) => c.x1)) - Math.min(w, ...comps.filter((c) => c.x1 - c.x0 > L * 3).map((c) => c.x0)));
  const lines = [];
  for (const c of comps) {
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0 + 1;
    // eine Textzeile: breit, höchstens ~1,5 Zeilenabstände hoch (gewölbte Zeilen sind etwas höher)
    if (cw < textW * 0.45 || ch < L * 0.25 || ch > L * 1.6) continue;
    const xs = [], ys = [];
    const step = Math.max(2, Math.round(L / 4));
    for (let x = c.x0; x <= c.x1; x += step) {
      let sy = 0, k = 0;
      for (let y = c.y0; y <= c.y1; y++) if (lab[y * w + x] === c.id) { sy += y; k++; }
      if (k >= 2) { xs.push(x / w); ys.push(sy / k); }
    }
    if (xs.length < 8) continue;
    const fit = fitQuad(xs, ys);
    if (!fit) continue;
    let err = 0;
    for (let i = 0; i < xs.length; i++) { const e = ys[i] - (fit[0] + fit[1] * xs[i] + fit[2] * xs[i] * xs[i]); err += e * e; }
    if (Math.sqrt(err / xs.length) > L * 0.22) continue;
    lines.push({ fit, x0: c.x0 / w, x1: c.x1 / w });
  }
  // schon drei sichere Zeilen reichen (kurze Seiten, Kapitelenden)
  if (lines.length < 3) return null;
  // Mittlere Höhe jeder Zeile (Ziel) und Ordnung von oben nach unten
  const at = (ln, x) => { const t = Math.min(ln.x1, Math.max(ln.x0, x)); return ln.fit[0] + ln.fit[1] * t + ln.fit[2] * t * t; };
  for (const ln of lines) {
    let s2 = 0; const n = 20;
    for (let k = 0; k <= n; k++) s2 += at(ln, ln.x0 + (ln.x1 - ln.x0) * k / n);
    ln.t = s2 / (n + 1);
  }
  lines.sort((a, b2) => a.t - b2.t);
  return { lines, L, w, h, s, at };
}

// Liefert ein neues Canvas mit gerade gezogenen Zeilen – oder null, wenn nichts zu tun ist.
export function dewarpText(src) {
  const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
  const a = analyzeLines(src, W, H);
  if (!a) return null;
  const { lines, L, h, at } = a;
  // Spalten-Raster: Verschiebung d(y) je Rasterspalte aus den Zeilen interpolieren
  const GX = 48;
  const cols = [];
  let maxD = 0;
  for (let k = 0; k <= GX; k++) {
    const x = k / GX;
    // Zeilen, deren Ziel- und Quellhöhe monoton steigen (sonst würde gefaltet)
    const pts = [];
    for (const ln of lines) {
      const sy = at(ln, x);
      const p = pts[pts.length - 1];
      if (p && (ln.t - p.t < L * 0.5 || sy - p.s < L * 0.5)) continue;
      pts.push({ t: ln.t, s: sy });
      maxD = Math.max(maxD, Math.abs(sy - ln.t));
    }
    cols.push(pts);
  }
  // Kaum Wölbung → Original behalten
  if (maxD < L * 0.18) return null;
  // Begrenzung gegen Ausreißer
  if (maxD > L * 4) return null;
  const scaleY = H / h; // Analyse → Original
  const dst = document.createElement('canvas');
  dst.width = W; dst.height = H;
  const sctx = (() => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0); return x; })();
  const sd = sctx.getImageData(0, 0, W, H).data;
  const dctx = dst.getContext('2d');
  const out = dctx.createImageData(W, H);
  const od = out.data;
  // Verschiebung für eine Rasterspalte und Höhe y (in Analyse-Pixeln)
  const dAt = (pts, y) => {
    if (!pts.length) return 0;
    if (y <= pts[0].t) return pts[0].s - pts[0].t;
    for (let i = 1; i < pts.length; i++) {
      if (y <= pts[i].t) {
        const a0 = pts[i - 1], a1 = pts[i];
        const f = (y - a0.t) / (a1.t - a0.t);
        return (a0.s - a0.t) * (1 - f) + (a1.s - a1.t) * f;
      }
    }
    const l = pts[pts.length - 1];
    return l.s - l.t;
  };
  // Verschiebungstabelle je Rasterspalte und Zeile (Originalauflösung)
  const table = cols.map((pts) => {
    const arr = new Float32Array(H);
    for (let y = 0; y < H; y++) arr[y] = dAt(pts, y / scaleY) * scaleY;
    return arr;
  });
  for (let x = 0; x < W; x++) {
    const gx = (x / Math.max(1, W - 1)) * GX;
    const k0 = Math.min(GX - 1, Math.floor(gx)), f = gx - k0;
    const t0 = table[k0], t1 = table[k0 + 1];
    for (let y = 0; y < H; y++) {
      const sy = y + t0[y] * (1 - f) + t1[y] * f;
      const yi = Math.floor(sy), fy = sy - yi;
      const o = (y * W + x) * 4;
      if (yi < 0 || yi >= H - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
      const p0 = (yi * W + x) * 4, p1 = p0 + W * 4;
      od[o] = sd[p0] * (1 - fy) + sd[p1] * fy;
      od[o + 1] = sd[p0 + 1] * (1 - fy) + sd[p1 + 1] * fy;
      od[o + 2] = sd[p0 + 2] * (1 - fy) + sd[p1 + 2] * fy;
      od[o + 3] = 255;
    }
  }
  dctx.putImageData(out, 0, 0);
  dst.dewarpInfo = { lines: lines.length, maxShift: Math.round(maxD * scaleY), period: Math.round(L * scaleY) };
  return dst;
}

// Großes Anfangszeichen (Initiale) am Kapitelanfang finden: ein einzelnes Zeichen, das
// 2–4 Zeilen hoch ist und links neben den ersten Zeilen steht.
// → { x0, y0, x1, y1 } in Bildkoordinaten oder null
export function findDropCap(src) {
  const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
  const s = Math.min(1, ANALYSIS_W / W);
  const w = Math.max(50, Math.round(W * s)), h = Math.max(50, Math.round(H * s));
  const b = binarize(grayOf(src, w, h), w, h);
  const t = textOnly(b, w, h);
  if (!t) return null;
  const L = linePeriod(t.b, w, h, t.mh);
  if (!L || L < 6) return null;
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!b[i] || lab[i]) continue;
    const id = comps.length + 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && b[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && b[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && b[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && b[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    if (n > 20) comps.push({ x0, x1, y0, y1, n });
  }
  // normale Buchstaben: Höhe ~ 0,3–0,8 Zeilenabstand
  const letters = comps.filter((c) => c.y1 - c.y0 < L * 0.9 && c.y1 - c.y0 > L * 0.2);
  if (letters.length < 50) return null;
  const left = letters.map((c) => c.x0).sort((a, b2) => a - b2)[Math.floor(letters.length * 0.02)];
  for (const c of comps) {
    const ch = c.y1 - c.y0, cw = c.x1 - c.x0;
    if (ch < L * 1.6 || ch > L * 4.2 || cw < L * 0.5 || cw > L * 3.5) continue;
    if (c.x0 > left + L * 1.5) continue;              // muss am linken Textrand stehen
    const fill = c.n / ((cw + 1) * (ch + 1));
    if (fill < 0.08 || fill > 0.75) continue;          // kein Bild, kein Rahmen
    // rechts daneben muss Text in Höhe der Oberkante beginnen
    const beside = letters.filter((l) => l.x0 > c.x1 && l.x0 < c.x1 + L * 3 && l.y0 > c.y0 - L * 0.6 && l.y0 < c.y0 + L * 0.6);
    if (beside.length < 2) continue;
    const k = 1 / s;
    return { x0: Math.max(0, (c.x0 - 2) * k), y0: Math.max(0, (c.y0 - 2) * k), x1: Math.min(W, (c.x1 + 2) * k), y1: Math.min(H, (c.y1 + 2) * k), L: L * k };
  }
  return null;
}
