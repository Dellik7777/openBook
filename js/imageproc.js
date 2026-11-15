// Bildverarbeitung für Buchseiten: Skalieren, Scan-Filter, Teilen, Drehen, Zuschneiden.

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

// "Scan-Look": Graustufen + automatische Tonwertkorrektur.
// Macht Papier hell, Schrift dunkel, verbessert OCR und spart Speicher.
export function enhance(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = y;
    hist[y]++;
  }
  const total = d.length / 4;
  // Schwarzpunkt bei 1 %, Weißpunkt bei 92 % (Papier soll sauber weiß werden)
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.92) { hi = v; break; } }
  if (hi - lo < 40) { lo = Math.max(0, lo - 20); hi = Math.min(255, hi + 20); }
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - lo) / (hi - lo);
    x = Math.min(1, Math.max(0, x));
    x = Math.pow(x, 1.25); // Schrift etwas kräftiger
    lut[v] = Math.round(x * 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = lut[d[i]];
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
export async function processCapture(source, { split = false, scanFilter = true } = {}) {
  const src = source instanceof Blob ? await loadBitmap(source) : source;
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
    out.push({ image, thumb });
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
