// Bildverarbeitung für Buchseiten: Skalieren, Scan-Filter, Teilen, Drehen, Zuschneiden.

import { detectPage, warpPerspective, flattenCurl } from './pagedetect.js';

const MAX_EDGE = 2200;   // lange Kante gespeicherter Seiten (gut lesbar + gute OCR)
const THUMB_EDGE = 320;
const JPEG_Q = 0.82;

export async function loadBitmap(src) {
  if (src instanceof HTMLCanvasElement) return src;
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(src, { imageOrientation: 'from-image' });
    } catch (e) { /* Fallback unten */ }
  }
  const url = URL.createObjectURL(src);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function dims(src) {
  return {
    w: src.videoWidth || src.naturalWidth || src.width,
    h: src.videoHeight || src.naturalHeight || src.height,
  };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function toBlob(c, type = 'image/jpeg', q = JPEG_Q) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, q);
  });
}

// Zeichnet einen Ausschnitt einer Quelle skaliert in ein neues Canvas.
function drawScaled(src, sx, sy, sw, sh, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = canvas(sw * scale, sh * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// "Scan-Look": Graustufen, Schatten entfernen, Papier weiß, Schrift dunkel.
// Der Papierhintergrund wird lokal geschätzt (großflächiges Maximum + Weichzeichnen),
// sodass Schatten von Hand/Handy, Falten und ungleichmäßiges Licht verschwinden.
export function enhance(c) {
  const W = c.width, H = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;

  // 1) Hintergrund auf kleinem Raster: Maximum je Zelle, dann Max-Filter + Weichzeichnen
  const cell = Math.max(8, Math.round(Math.max(W, H) / 160));
  const bw = Math.ceil(W / cell), bh = Math.ceil(H / cell);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // hellster Wert der Zelle (robust: 2.-hellster Wert per Histogramm wäre genauer, Max reicht)
      let m = 0;
      const y1 = Math.min(H, (by + 1) * cell), x1 = Math.min(W, (bx + 1) * cell);
      for (let y = by * cell; y < y1; y += 2) {
        const row = y * W;
        for (let x = bx * cell; x < x1; x += 2) if (g[row + x] > m) m = g[row + x];
      }
      bg[by * bw + bx] = m;
    }
  }
  const pass = (src, fn) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let acc = fn === 'max' ? 0 : 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
        const v = src[yy * bw + xx];
        if (fn === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
      }
      out[y * bw + x] = fn === 'max' ? acc : acc / n;
    }
    return out;
  };
  bg = pass(pass(bg, 'max'), 'avg');
  bg = pass(bg, 'avg');

  // 2) Pixel durch Hintergrund teilen (bilinear interpoliert)
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(fx), tx = fx - x0;
      const i0 = y0 * bw + x0;
      const b = (bg[i0] * (1 - tx) + bg[i0 + 1] * tx) * (1 - ty) + (bg[i0 + bw] * (1 - tx) + bg[i0 + bw + 1] * tx) * ty;
      const v = Math.min(255, (g[y * W + x] * 255) / Math.max(40, b));
      g[y * W + x] = v;
      hist[v | 0]++;
    }
  }

  // 3) Tonwerte: Schwarzpunkt bei 1 %, Papier (inkl. durchscheinender Rückseite) wird weiß
  const total = W * H;
  let acc = 0, lo = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
  const hi = 232;
  if (hi - lo < 60) lo = Math.max(0, hi - 60);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - lo) / (hi - lo);
    x = Math.min(1, Math.max(0, x));
    lut[v] = Math.round(Math.pow(x, 1.3) * 255);
  }
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const v = lut[g[j]];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function makeThumb(src) {
  const { w, h } = dims(src);
  const c = drawScaled(src, 0, 0, w, h, THUMB_EDGE);
  return toBlob(c, 'image/jpeg', 0.7);
}

// Erzeugt aus einer Aufnahme (Video-Frame, Canvas, Blob) eine oder zwei Seiten.
// Ergebnis: [{ image: Blob, thumb: Blob }]
export async function processCapture(source, { split = false, scanFilter = true, autoCrop = true } = {}) {
  let src = source instanceof Blob ? await loadBitmap(source) : source;
  let cropped = false;
  if (autoCrop) {
    // Seite im Foto finden, Perspektive entzerren, Wölbung glätten
    try {
      const det = detectPage(src);
      if (det) {
        const warped = flattenCurl(warpPerspective(src, det.quad, split ? MAX_EDGE * 1.6 : MAX_EDGE));
        if (src.close) try { src.close(); } catch (e) { /* */ }
        src = warped;
        cropped = true;
      }
    } catch (e) { console.warn('Seitenerkennung übersprungen', e); }
  }
  const { w, h } = dims(src);
  const parts = split
    ? [[0, 0, Math.floor(w / 2), h], [Math.floor(w / 2), 0, w - Math.floor(w / 2), h]]
    : [[0, 0, w, h]];
  const out = [];
  for (const [sx, sy, sw, sh] of parts) {
    const c = drawScaled(src, sx, sy, sw, sh, MAX_EDGE);
    if (scanFilter) enhance(c);
    const image = await toBlob(c);
    const thumb = await makeThumb(c);
    out.push({ image, thumb, cropped });
  }
  if (src.close) try { src.close(); } catch (e) { /* ignorieren */ }
  return out;
}

// Grabbt das aktuelle Videobild in voller Auflösung.
export function grabFrame(video) {
  const c = canvas(video.videoWidth, video.videoHeight);
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

export async function rotate(blob, deg) {
  const src = await loadBitmap(blob);
  const { w, h } = dims(src);
  const quarter = ((deg % 360) + 360) % 360;
  const swap = quarter === 90 || quarter === 270;
  const c = canvas(swap ? h : w, swap ? w : h);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((quarter * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2);
  const image = await toBlob(c);
  const thumb = await makeThumb(c);
  return { image, thumb };
}

// rect in relativen Koordinaten (0..1)
export async function crop(blob, rect) {
  const src = await loadBitmap(blob);
  const { w, h } = dims(src);
  const sx = Math.round(rect.x * w), sy = Math.round(rect.y * h);
  const sw = Math.round(rect.w * w), sh = Math.round(rect.h * h);
  const c = drawScaled(src, sx, sy, sw, sh, MAX_EDGE);
  const image = await toBlob(c);
  const thumb = await makeThumb(c);
  return { image, thumb };
}

// Cover: farbig, etwas kleiner
export async function processCover(blob) {
  const src = await loadBitmap(blob);
  const { w, h } = dims(src);
  const c = drawScaled(src, 0, 0, w, h, 900);
  return toBlob(c, 'image/jpeg', 0.8);
}

// Ausschnitt einer Seite als Abbildung (rect relativ 0..1), max. 1600 px
export async function cropFigure(blob, rect) {
  const src = await loadBitmap(blob);
  const { w, h } = dims(src);
  const sx = Math.round(rect.x * w), sy = Math.round(rect.y * h);
  const sw = Math.max(1, Math.round(rect.w * w)), sh = Math.max(1, Math.round(rect.h * h));
  const c = drawScaled(src, sx, sy, sw, sh, 1600);
  const image = await toBlob(c, 'image/jpeg', 0.82);
  if (src.close) try { src.close(); } catch (e) { /* ignorieren */ }
  return { image, w: c.width, h: c.height };
}
