// Zitat als gestaltete Bildkarte (zum Teilen per Nachricht, WhatsApp, Instagram …)

import { h, icon, sheet, toast, download, safeName } from './ui.js';

export const DESIGNS = {
  paper: { name: 'Papier', bg: '#fbf8f1', ink: '#24201b', muted: '#8a8174', accent: '#F28C28' },
  night: { name: 'Nacht', bg: '#1d2433', ink: '#f3efe6', muted: '#a7b0c2', accent: '#F28C28' },
  orange: { name: 'Orange', bg: '#F28C28', ink: '#1d2433', muted: '#5a3410', accent: '#1d2433' },
};

function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

// → HTMLCanvasElement (1080 × 1350, Hochformat wie bei Instagram)
export async function renderCard({ text, title, author = '', design = 'paper' }) {
  const d = DESIGNS[design] || DESIGNS.paper;
  try { await Promise.all([document.fonts.load('italic 60px Literata'), document.fonts.load('600 30px Montserrat')]); } catch (e) { /* Ersatzschrift */ }
  const W = 1080, H = 1350, pad = 110;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = d.bg; x.fillRect(0, 0, W, H);
  // dezente Pixel als Marke
  x.fillStyle = d.accent;
  [[0, 0], [1, 0], [0, 1]].forEach(([a, b]) => x.fillRect(pad + a * 34, pad + b * 34, 26, 26));
  // Text: Größe so wählen, dass er in den Bereich passt
  let quote = text.replace(/\s+/g, ' ').trim();
  if (quote.length > 420) quote = quote.slice(0, 420).replace(/\s\S*$/, '') + ' …';
  const top = 260, bottom = H - 300;
  let size = 72, lines = [];
  for (; size >= 34; size -= 2) {
    x.font = `italic ${size}px Literata, Georgia, serif`;
    lines = wrap(x, `»${quote}«`, W - pad * 2);
    if (lines.length * size * 1.42 <= bottom - top) break;
  }
  x.fillStyle = d.ink;
  x.textBaseline = 'top';
  const lh = size * 1.42;
  const y0 = top + Math.max(0, (bottom - top - lines.length * lh) / 2);
  lines.forEach((l, i) => x.fillText(l, pad, y0 + i * lh));
  // Linie + Quelle
  x.fillStyle = d.accent;
  x.fillRect(pad, H - 250, 90, 6);
  x.fillStyle = d.ink;
  x.font = '600 36px Montserrat, sans-serif';
  const t = wrap(x, title, W - pad * 2).slice(0, 2);
  t.forEach((l, i) => x.fillText(l, pad, H - 220 + i * 46));
  if (author) {
    x.fillStyle = d.muted;
    x.font = '500 30px Montserrat, sans-serif';
    x.fillText(author, pad, H - 220 + t.length * 46 + 8);
  }
  x.fillStyle = d.muted;
  x.font = '500 22px Montserrat, sans-serif';
  x.textAlign = 'right';
  x.fillText('Lesepixel', W - pad, H - 80);
  return c;
}

// Dialog: Vorschau, Gestaltung wählen, teilen oder speichern
export function openQuoteCard({ text, title, author }) {
  let design = 'paper';
  try { design = localStorage.getItem('ob.quoteDesign') || 'paper'; } catch (e) { /* */ }
  const img = h('img', { class: 'quote-preview', alt: 'Zitatkarte' });
  let canvas = null, url = null;
  const draw = async () => {
    canvas = await renderCard({ text, title, author, design });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    img.src = url;
    return blob;
  };
  const pick = h('div', { class: 'segmented' }, ...Object.entries(DESIGNS).map(([k, v]) => h('button', {
    class: k === design ? 'on' : '', 'data-k': k,
    onClick: () => {
      design = k;
      try { localStorage.setItem('ob.quoteDesign', k); } catch (e) { /* */ }
      pick.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      draw();
    },
  }, v.name)));
  const fileName = safeName(title).slice(0, 40) + '-zitat.png';
  const share = async () => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: `Aus „${title}“` }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    download(blob, fileName);
    toast('Bild gespeichert');
  };
  sheet('Zitat teilen', h('div', { class: 'stack' },
    img, pick,
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn primary', onClick: share }, icon('upload'), 'Teilen'),
      h('button', { class: 'btn', onClick: async () => { download(await new Promise((r) => canvas.toBlob(r, 'image/png')), fileName); } }, icon('download'), 'Speichern')),
    h('p', { class: 'muted small' }, 'Kurze Zitate mit Quellenangabe sind erlaubt. Bitte keine längeren Passagen teilen.'),
  ), { onClose: () => { if (url) URL.revokeObjectURL(url); } });
  draw();
}
