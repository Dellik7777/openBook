// Seite im Foto finden, Perspektive entzerren, Wölbung glätten und Bildqualität prüfen.
// Ohne externe Bibliotheken: Helligkeitsschwelle → größte helle Fläche → vier Ecken → Homographie.

function grayOf(src, maxEdge, paper = false) {
  const w0 = src.videoWidth || src.naturalWidth || src.width;
  const h0 = src.videoHeight || src.naturalHeight || src.height;
  const s = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(8, Math.round(w0 * s)), h = Math.max(8, Math.round(h0 * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256;
    if (!paper) { g[j] = y; continue; }
    const chroma = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    g[j] = Math.max(0, y - 1.6 * chroma) + 0.35 * y;
  }
  return { g, w, h, scale: s, w0, h0 };
}

function boxBlur(g, w, h, r) {
  const out = new Float32Array(g.length), tmp = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    let acc = 0, n = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w) { acc += g[y * w + x + r]; n++; }
      if (x - r - 1 >= 0) { acc -= g[y * w + x - r - 1]; n--; }
      if (x >= 0) tmp[y * w + x] = acc / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
      if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
      if (y >= 0) out[y * w + x] = acc / n;
    }
  }
  return out;
}

function otsu(g) {
  const hist = new Uint32Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// Größte zusammenhängende helle Fläche (Papier) als Maske.
// spread: bei Doppelseiten auch die zweite Seite dazunehmen, wenn sie gleich groß daneben liegt
// (der dunkle Bundsteg trennt die beiden Seiten oft in zwei Flächen)
function paperMask(gray, { spread = false } = {}) {
  const { w, h } = gray;
  const b = boxBlur(gray.g, w, h, 2);
  const t = otsu(b);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = b[i] > t ? 1 : 0;
  // Text auf dem Papier schließt die Fläche nicht auf: großzügig weichzeichnen und erneut schwellen
  const closed = boxBlur(Float32Array.from(mask, (v) => v * 255), w, h, 4);
  for (let i = 0; i < mask.length; i++) mask[i] = closed[i] > 110 ? 1 : 0;
  const label = new Int32Array(w * h).fill(-1);
  let bestId = -1, bestArea = 0, id = 0;
  const areas = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    let sp = 0, area = 0;
    stack[sp++] = i; label[i] = id;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[sp++] = p + w; }
    }
    areas.push(area);
    if (area > bestArea) { bestArea = area; bestId = id; }
    id++;
  }
  let secondId = -1;
  if (spread && areas.length > 1) {
    // zweitgrößte Fläche, wenn sie ähnlich groß ist und seitlich daneben liegt
    let s2 = -1, a2 = 0;
    areas.forEach((a, k) => { if (k !== bestId && a > a2) { a2 = a; s2 = k; } });
    if (s2 >= 0 && a2 > bestArea * 0.4) {
      const bb = (lid) => { let x0 = w, x1 = 0, y0 = h, y1 = 0; for (let i = 0; i < label.length; i++) if (label[i] === lid) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, x1, y0, y1 }; };
      const A = bb(bestId), B = bb(s2);
      const vov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
      const side = B.x0 > A.x1 - w * 0.05 || B.x1 < A.x0 + w * 0.05;
      if (side && vov > Math.min(A.y1 - A.y0, B.y1 - B.y0) * 0.6) secondId = s2;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === bestId || (secondId >= 0 && label[i] === secondId) ? 1 : 0;
  return { mask: out, area: bestArea + (secondId >= 0 ? areas[secondId] : 0) };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z === 0) continue;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// → { quad: [[x,y] TL, TR, BR, BL] in Originalkoordinaten } oder null (Seite füllt das Bild / nicht sicher erkannt)
export function detectPage(src, { spread = false } = {}) {
  const gray = grayOf(src, 420, true);
  const { w, h } = gray;
  const { mask, area } = paperMask(gray, { spread });
  const ratio = area / (w * h);
  if (ratio < 0.15) return null;
  let tl, tr, br, bl, mTL = Infinity, mTR = -Infinity, mBR = -Infinity, mBL = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const s = x + y, d = x - y;
      if (s < mTL) { mTL = s; tl = [x, y]; }
      if (s > mBR) { mBR = s; br = [x, y]; }
      if (d > mTR) { mTR = d; tr = [x, y]; }
      if (d < mBL) { mBL = d; bl = [x, y]; }
    }
  }
  if (!tl) return null;
  const q = [tl, tr, br, bl];
  const qa = polyArea(q);
  // Plausibilität: konvex, Fläche passt zur Papierfläche, Seiten nicht zu kurz
  if (!convex(q) || qa < area * 0.75 || qa > area * 1.35) return null;
  if (Math.min(dist(tl, tr), dist(bl, br)) < w * 0.25 || Math.min(dist(tl, bl), dist(tr, br)) < h * 0.25) return null;
  // Sicherheitsprüfung: Liegt außerhalb des Vierecks noch Schrift? Dann lieber nicht zuschneiden.
  if (textOutside(src, q, w, h)) return null;
  // Füllt die Seite (fast) das ganze Bild und ist kaum schief, lohnt sich keine Entzerrung
  const nearEdge = q.every(([x, y]) => (x < w * 0.03 || x > w * 0.97) && (y < h * 0.03 || y > h * 0.97));
  if (nearEdge) return null;
  // Ecken leicht nach innen ziehen, damit keine Tischkante stehen bleibt
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4, cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const k = 1 / gray.scale;
  return { quad: q.map(([x, y]) => [(x + (cx - x) * 0.012) * k, (y + (cy - y) * 0.012) * k]), coverage: ratio };
}

// Dichte kräftiger Kanten (Schrift) außerhalb vs. innerhalb des Vierecks
function textOutside(src, q, w, h) {
  const { g } = grayOf(src, Math.max(w, h));
  const inside = (x, y, shrink) => {
    // Punkt im (um „shrink“ Pixel vergrößerten) Viereck? über Vorzeichen der Kreuzprodukte
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const ax = a[0] + Math.sign(a[0] - cx) * shrink, ay = a[1] + Math.sign(a[1] - cy) * shrink;
      const bx = b[0] + Math.sign(b[0] - cx) * shrink, by = b[1] + Math.sign(b[1] - cy) * shrink;
      const z = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign && z !== 0) return false;
    }
    return true;
  };
  const band = Math.max(4, Math.round(Math.max(w, h) * 0.03));
  let inEdges = 0, inN = 0, outEdges = 0, outN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      const strong = Math.abs(gx) + Math.abs(gy) > 70 ? 1 : 0;
      if (inside(x, y, -band)) { inEdges += strong; inN++; }
      else if (!inside(x, y, band)) { outEdges += strong; outN++; }
    }
  }
  if (!outN || !inN) return false;
  const din = inEdges / inN, dout = outEdges / outN;
  return dout > 0.004 && dout > din * 0.25;
}

// Homographie: Zielrechteck (0..W, 0..H) → Quellviereck
function homography(W, H, q) {
  const src = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauß-Elimination
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Viereck aus der Quelle auf ein Rechteck abbilden (bilinear), lange Kante max. maxEdge
export function warpPerspective(src, quad, maxEdge = 2200) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, maxEdge / Math.max(W, H));
  W = Math.round(W * s); H = Math.round(H * s);
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0);
  const sd = sctx.getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  const o = od.data;
  const m = homography(W, H, quad);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = m[6] * x + m[7] * y + 1;
      const u = (m[0] * x + m[1] * y + m[2]) / den, v = (m[3] * x + m[4] * y + m[5]) / den;
      const x0 = Math.max(0, Math.min(sw - 2, u | 0)), y0 = Math.max(0, Math.min(sh - 2, v | 0));
      const fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const j = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        o[j + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      }
      o[j + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// Wölbung glätten: obere/untere Papierkante je Spalte finden und Spalten senkrecht strecken.
// Wirkt nur, wenn beide Kanten sichtbar und deutlich gekrümmt sind.
export function flattenCurl(canvas) {
  const gray = grayOf(canvas, 400, true);
  const { w, h } = gray;
  const { mask } = paperMask(gray);
  const top = new Float32Array(w), bot = new Float32Array(w);
  let ok = 0;
  for (let x = 0; x < w; x++) {
    let t = -1, b = -1;
    for (let y = 0; y < h; y++) if (mask[y * w + x]) { t = y; break; }
    for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { b = y; break; }
    top[x] = t; bot[x] = b;
    if (t >= 0 && b > t + h * 0.5) ok++;
  }
  if (ok < w * 0.85) return canvas;
  const smooth = (arr) => {
    const out = new Float32Array(arr.length);
    for (let x = 0; x < arr.length; x++) {
      const win = [];
      for (let k = -6; k <= 6; k++) { const v = arr[Math.max(0, Math.min(arr.length - 1, x + k))]; if (v >= 0) win.push(v); }
      win.sort((a, b) => a - b);
      out[x] = win.length ? win[win.length >> 1] : -1;
    }
    return out;
  };
  const T = smooth(top), B = smooth(bot);
  // Abweichung jeder Kante von der Geraden zwischen ihren Enden
  const devArr = (arr) => Float32Array.from(arr, (v, x) => v - (arr[0] + (arr[w - 1] - arr[0]) * x / (w - 1)));
  const dT = devArr(T), dB = devArr(B);
  const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const mT = maxAbs(dT), mB = maxAbs(dB);
  if (Math.max(mT, mB) / h < 0.012) return canvas;   // praktisch gerade
  if (Math.max(mT, mB) / h > 0.15) return canvas; // unplausibel stark
  // Sind obere und untere Kante gleich gebogen, beide mitteln. Sonst die „ruhigere“ Kante nehmen
  // (Schatten oder Finger machen eine Kante unruhig) – und nur, wenn sie glatt gekrümmt ist.
  let dot = 0, nT = 0, nB = 0;
  for (let x = 0; x < w; x++) { dot += dT[x] * dB[x]; nT += dT[x] ** 2; nB += dB[x] ** 2; }
  const corr = dot / Math.sqrt(nT * nB || 1);
  const rough = (a) => { let r = 0; for (let x = 1; x < w - 1; x++) r += Math.abs(a[x - 1] - 2 * a[x] + a[x + 1]); return r / w; };
  let shift;
  if (corr > 0.8 && Math.max(mT, mB) / Math.max(1, Math.min(mT, mB)) < 1.8) shift = Float32Array.from(dT, (v, x) => (v + dB[x]) / 2);
  else {
    const useTop = rough(dT) <= rough(dB);
    const edge = useTop ? dT : dB;
    if (rough(edge) > 0.6 || maxAbs(edge) / h < 0.012) return canvas;
    shift = edge;
  }
  const W = canvas.width, H = canvas.height;
  const kx = w / W, ky = H / h;
  const sctx = canvas.getContext('2d', { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  const o = od.data;
  for (let X = 0; X < W; X++) {
    const xs = Math.min(w - 1, X * kx);
    const x0 = xs | 0, f = xs - x0, x1 = Math.min(w - 1, x0 + 1);
    const sh = (shift[x0] * (1 - f) + shift[x1] * f) * ky;
    for (let Y = 0; Y < H; Y++) {
      const ys = Y + sh;
      const j = (Y * W + X) * 4;
      if (ys < 0 || ys > H - 1) { o[j] = o[j + 1] = o[j + 2] = 245; o[j + 3] = 255; continue; }
      const y0 = Math.min(H - 2, ys | 0), fy = ys - y0;
      const i0 = (y0 * W + X) * 4, i1 = i0 + W * 4;
      for (let c = 0; c < 3; c++) o[j + c] = sd[i0 + c] * (1 - fy) + sd[i1 + c] * fy;
      o[j + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// Bildqualität: Schärfe (Varianz des Laplace-Operators) und Helligkeit
export function quality(src) {
  const { g, w, h } = grayOf(src, 800);
  let sum = 0, n = 0, mean = 0, mean2 = 0;
  for (const v of g) mean += v;
  mean /= g.length;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += lap; mean2 += lap * lap; n++;
    }
  }
  const m = sum / n;
  const sharp = mean2 / n - m * m;
  return { sharp, bright: mean };
}

// Schnelles Bewegungsmaß für den Auto-Auslöser (sehr kleines Graustufenbild)
export function motionProbe(video, prev) {
  const { g } = grayOf(video, 64);
  if (!prev) return { frame: g, diff: Infinity };
  let d = 0;
  for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - prev[i]);
  return { frame: g, diff: d / g.length };
}

// Bundsteg einer Doppelseite finden: im mittleren Bereich die Stelle ohne Schrift
// (Innenränder beider Seiten), dort die dunkelste Spalte (Schatten der Bindung).
// → x in Pixeln des Bilds
export function findGutter(src) {
  const { g, w, h, scale } = grayOf(src, 700);
  const x0 = Math.round(w * 0.3), x1 = Math.round(w * 0.7);
  const edge = new Float32Array(w), mean = new Float32Array(w);
  const yA = Math.round(h * 0.08), yB = Math.round(h * 0.92);
  for (let x = Math.max(1, x0 - 10); x < Math.min(w - 1, x1 + 10); x++) {
    let e = 0, m = 0;
    for (let y = yA; y < yB; y++) {
      const i = y * w + x;
      if (Math.abs(g[i + 1] - g[i - 1]) > 40) e++;
      m += g[i];
    }
    edge[x] = e / (yB - yA);
    mean[x] = m / (yB - yA);
  }
  // geglättet
  const sm = (arr, r) => { const o = new Float32Array(w); for (let x = x0; x < x1; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { s += arr[x + k] || 0; n++; } o[x] = s / n; } return o; };
  const e2 = sm(edge, 3), m2 = sm(mean, 2);
  const band = [];
  for (let x = x0; x < x1; x++) band.push(e2[x]);
  const sorted = [...band].sort((a, b) => a - b);
  const thr = Math.max(0.004, sorted[Math.floor(sorted.length * 0.5)] * 0.35);
  // Läufe ohne Schrift, der Mitte am nächsten
  let best = null;
  for (let x = x0; x < x1;) {
    if (e2[x] > thr) { x++; continue; }
    let e = x;
    while (e < x1 && e2[e] <= thr) e++;
    const len = e - x, c = (x + e) / 2;
    if (len >= Math.max(3, w * 0.008)) {
      const score = Math.abs(c - w / 2) - len * 0.5;
      if (!best || score < best.score) best = { a: x, b: e, score };
    }
    x = e;
  }
  let gx = Math.round(w / 2);
  if (best) {
    gx = best.a;
    let lo = Infinity, hi = -Infinity;
    for (let x = best.a; x < best.b; x++) { if (m2[x] < m2[gx]) gx = x; lo = Math.min(lo, m2[x]); hi = Math.max(hi, m2[x]); }
    // kein erkennbarer Schatten (flach aufliegendes Buch): Mitte des schriftfreien Bereichs
    if (hi - lo < 6) gx = Math.round((best.a + best.b) / 2);
  }
  return Math.round(gx / scale);
}

// Füllt die Seite fast das ganze Bild (Ecken nicht erkennbar), dunkle Randstreifen trotzdem
// abschneiden (Tisch, Hand, Hintergrund oben/unten/seitlich). → { x, y, w, h } relativ oder null
export function trimDarkBorders(src) {
  const gray = grayOf(src, 420, true);
  const { g, w, h } = gray;
  const t = otsu(g);
  const paperRow = (y) => { let n = 0; for (let x = 0; x < w; x++) if (g[y * w + x] > t) n++; return n / w; };
  const paperCol = (x, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) if (g[y * w + x] > t) n++; return n / Math.max(1, y1 - y0); };
  let top = 0, bottom = h - 1;
  while (top < h * 0.25 && paperRow(top) < 0.5) top++;
  while (bottom > h * 0.75 && paperRow(bottom) < 0.5) bottom--;
  let left = 0, right = w - 1;
  while (left < w * 0.25 && paperCol(left, top, bottom) < 0.5) left++;
  while (right > w * 0.75 && paperCol(right, top, bottom) < 0.5) right--;
  // ein paar Pixel Sicherheitsabstand nach innen (Übergangskante)
  const pad = Math.round(Math.min(w, h) * 0.006);
  if (top > 0) top = Math.min(h - 1, top + pad);
  if (bottom < h - 1) bottom = Math.max(0, bottom - pad);
  if (left > 0) left = Math.min(w - 1, left + pad);
  if (right < w - 1) right = Math.max(0, right - pad);
  const area = ((right - left + 1) * (bottom - top + 1)) / (w * h);
  if (area > 0.97 || area < 0.4) return null;
  return { x: left / w, y: top / h, w: (right - left + 1) / w, h: (bottom - top + 1) / h };
}
