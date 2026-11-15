// Erkennt fette und kursive Wörter direkt aus den Bildpunkten.
// (Die LSTM-Texterkennung liefert keine Schriftschnitte, deshalb eigene Messung.)
//
//  fett:   mittlere Strichstärke (Länge der Tinten-Läufe) im Verhältnis zur Zeilenhöhe,
//          verglichen mit dem Median der Seite
//  kursiv: Schräglage – bei welcher Scherung stehen die senkrechten Striche am geradesten?

// Graustufenbild + Schwellwert (Otsu) aus einem Bild/Canvas
export function grayImage(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    g[j] = v; hist[v]++;
  }
  return { g, w, h, thr: otsu(hist, g.length) };
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Mittlere Lauflänge der Tinte (horizontal und vertikal) ≈ Strichstärke
function strokeWidth(img, x0, y0, x1, y1) {
  const { g, w, thr } = img;
  let ink = 0, hRuns = 0, vRuns = 0;
  for (let y = y0; y < y1; y++) {
    let inRun = false;
    for (let x = x0; x < x1; x++) {
      const on = g[y * w + x] < thr;
      if (on) { ink++; if (!inRun) { hRuns++; inRun = true; } } else inRun = false;
    }
  }
  for (let x = x0; x < x1; x++) {
    let inRun = false;
    for (let y = y0; y < y1; y++) {
      const on = g[y * w + x] < thr;
      if (on) { if (!inRun) { vRuns++; inRun = true; } } else inRun = false;
    }
  }
  if (!ink || !hRuns || !vRuns) return null;
  // Horizontale Läufe messen die Breite senkrechter Striche, vertikale die Dicke waagerechter
  return { h: ink / hRuns, v: ink / vRuns, ink };
}

// Schräglage der Buchstaben: Richtung der Kanten senkrechter Striche (Sobel-Gradient).
// Aufrechte Schrift → Kanten senkrecht (Winkel ≈ 0°), Kursivschrift → ≈ 10–15° geneigt.
// Ergebnis in Grad (positiv = nach rechts geneigt), gewichtet nach Kantenstärke.
function slantAngle(img, x0, y0, x1, y1) {
  const { g, w } = img;
  const bins = new Float64Array(37); // −36°…36° in 2°-Schritten
  let total = 0;
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const i = y * w + x;
      const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag < 120) continue;
      // nur fast waagerechte Gradienten = Kanten fast senkrechter Striche
      if (Math.abs(gy) > Math.abs(gx) * 0.72) continue;
      const a = Math.atan(gy / gx) * 57.2958;
      bins[Math.max(0, Math.min(36, Math.round((a + 36) / 2)))] += mag;
      total += mag;
    }
  }
  if (total < 400) return null;
  // Häufigste Richtung (gerade Stämme ergeben eine deutliche Spitze, Rundungen verteilen sich)
  let best = 18, bestV = -1;
  for (let k = 1; k < 36; k++) {
    const v = bins[k - 1] + 2 * bins[k] + bins[k + 1];
    if (v > bestV) { bestV = v; best = k; }
  }
  // Feinlage per Schwerpunkt um die Spitze
  const num = (best - 1) * bins[best - 1] + best * bins[best] + (best + 1) * bins[best + 1];
  const den = bins[best - 1] + bins[best] + bins[best + 1];
  // Anteil senkrechter Kanten (um 0°) im Vergleich zur Spitze: bei echter Kursivschrift klein,
  // bei aufrechten Wörtern mit schrägen Buchstaben (W, V, A …) groß
  const upright = bins[17] + bins[18] + bins[19];
  return { a: (den ? num / den : best) * 2 - 36, n: total, dom: den / Math.max(1, upright) };
}

// Vorzeichen der Neigung von Kursivschrift (gemessen an Testseiten)
const ITALIC_SIGN = 1;

// words: [{ bbox:{x0,y0,x1,y1}, text, lineH }] → setzt word.bold / word.italic
// scale: Faktor zwischen OCR-Koordinaten und Graustufenbild
export function detectStyles(img, words, scale = 1, debug = null) {
  const m = [];
  for (const wd of words) {
    const b = wd.bbox;
    const x0 = Math.max(0, Math.floor(b.x0 * scale) + 1), x1 = Math.min(img.w, Math.ceil(b.x1 * scale) - 1);
    const y0 = Math.max(0, Math.floor(b.y0 * scale) + 1), y1 = Math.min(img.h, Math.ceil(b.y1 * scale) - 1);
    const letters = (wd.text.match(/[A-Za-zÄÖÜäöüß0-9]/g) || []).length;
    if (x1 - x0 < 4 || y1 - y0 < 6 || !letters) { m.push(null); continue; }
    const sw = strokeWidth(img, x0, y0, x1, y1);
    if (!sw) { m.push(null); continue; }
    const lineH = Math.max(6, (wd.lineH || (b.y1 - b.y0)) * scale);
    const alpha = (wd.text.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
    const italic = alpha >= 3 ? slantAngle(img, x0, y0, x1, y1) : null;
    const caps = /^[^a-zäöüß]*$/.test(wd.text);
    m.push({ stroke: sw.h / lineH, letters, italic, caps, lineId: wd.lineId });
  }
  const strokes = m.filter((x) => x && x.letters >= 3).map((x) => x.stroke).sort((a, b) => a - b);
  const med = strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0;
  // Median je Zeile (für einzelne fette Wörter im Fließtext)
  const byLine = new Map();
  m.forEach((x) => { if (x && x.letters >= 3) { if (!byLine.has(x.lineId)) byLine.set(x.lineId, []); byLine.get(x.lineId).push(x.stroke); } });
  const lineMed = new Map([...byLine].map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
  // Typische Schräglage der Seite (gleicht schief fotografierte Seiten aus)
  const angles = m.filter((x) => x && x.italic).map((x) => x.italic.a).sort((a, b) => a - b);
  const medA = angles.length ? angles[Math.floor(angles.length / 2)] : 0;
  words.forEach((wd, i) => {
    const x = m[i];
    wd.bold = false; wd.italic = false;
    if (!x || !med) return;
    const r = x.stroke / med;
    const rl = x.stroke / (lineMed.get(x.lineId) || x.stroke);
    if (x.caps) wd.bold = r > 1.6;                          // Großbuchstaben wirken von Natur aus kräftiger
    else wd.bold = r > 1.5 || (r > 1.38 && x.letters >= 5) || (rl > 1.28 && r > 1.15 && x.letters >= 3);
    const dA = x.italic ? x.italic.a - medA : 0;
    wd.italic = !!(x.italic && Math.abs(dA) > 6 && Math.sign(dA) === ITALIC_SIGN && x.italic.dom > 3);
    if (debug) debug.push({ t: wd.text, st: +r.toFixed(2), rl: +rl.toFixed(2), a: x.italic && +dA.toFixed(1), dom: x.italic && +x.italic.dom.toFixed(2), b: wd.bold, i: wd.italic });
  });
  // Einzelne kurze Wörter zwischen gleich formatierten Nachbarn angleichen (z. B. „in“, „-“)
  for (let i = 1; i < words.length - 1; i++) {
    const a = words[i - 1], c = words[i + 1], wd = words[i];
    if (wd.lineId !== a.lineId || wd.lineId !== c.lineId) continue;
    if (!m[i] || m[i].letters <= 2) {
      if (a.bold && c.bold) wd.bold = true;
      if (a.italic && c.italic) wd.italic = true;
    }
  }
  return med;
}
