// Buch per ISBN anlegen: Strichcode mit der Kamera lesen (oder ISBN eintippen)
// und Titel, Autor und Cover online nachschlagen (Open Library, ersatzweise Google Books).
// Nachgeschlagen wird nur auf ausdrücklichen Wunsch; dabei wird nur die ISBN übertragen.

import { h, icon, sheet, toast } from './ui.js';
import { decodeEan13, grayFromCanvas, normalizeIsbn, isIsbn } from './barcode.js';

// Kamera-Sheet; liefert die gelesene ISBN-13 oder null (abgebrochen)
export function scanIsbn() {
  return new Promise((resolve) => {
    let stream = null, stopped = false, done = false, timer = null;
    const video = h('video', { class: 'isbn-video', playsinline: true, muted: true, autoplay: true });
    const info = h('p', { class: 'muted small' }, 'Halte den Strichcode auf der Rückseite des Buchs in den Rahmen.');
    const manual = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'oder ISBN eintippen', autocomplete: 'off', 'aria-label': 'ISBN eintippen' });
    const finish = (code) => {
      if (done) return;
      done = true;
      stop();
      s.close();
      resolve(code);
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    const s = sheet('ISBN scannen', h('div', { class: 'stack' },
      h('div', { class: 'isbn-camera' }, video, h('div', { class: 'isbn-frame' }, h('span', { class: 'isbn-line' }))),
      info,
      h('form', { class: 'row gap-s', onSubmit: (e) => {
        e.preventDefault();
        const code = normalizeIsbn(manual.value);
        if (!code) { toast('Das ist keine gültige ISBN'); manual.focus(); return; }
        finish(code);
      } }, manual, h('button', { class: 'btn', type: 'submit' }, 'OK')),
    ), { onClose: () => { stop(); if (!done) { done = true; resolve(null); } } });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch (e) {
        info.textContent = 'Kamera nicht verfügbar – bitte die ISBN eintippen (steht über dem Strichcode).';
        video.closest('.isbn-camera').hidden = true;
        manual.focus();
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      let detector = null;
      try {
        if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('ean_13')) {
          detector = new window.BarcodeDetector({ formats: ['ean_13'] });
        }
      } catch (e) { /* eigener Leser */ }
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      let last = null;
      const tick = async () => {
        if (stopped) return;
        try {
          if (video.videoWidth) {
            let code = null;
            if (detector) {
              const r = await detector.detect(video);
              code = r.map((x) => x.rawValue).find(isIsbn) || null;
            }
            if (!code) {
              // Mittelteil des Bilds in mäßiger Auflösung (schneller, Strichcode liegt im Rahmen)
              const vw = video.videoWidth, vh = video.videoHeight;
              const scale = Math.min(1, 960 / vw);
              c.width = Math.round(vw * scale);
              c.height = Math.round(vh * scale);
              ctx.drawImage(video, 0, 0, c.width, c.height);
              code = decodeEan13(grayFromCanvas(ctx, c.width, c.height), c.width, c.height);
              if (code && !isIsbn(code)) { info.textContent = 'Das ist kein ISBN-Strichcode (vielleicht der Preis-Code daneben?).'; code = null; }
            }
            // zweimal hintereinander dasselbe gelesen → sicher
            if (code && (detector || code === last)) { if (navigator.vibrate) navigator.vibrate(40); finish(code); return; }
            last = code;
          }
        } catch (e) { console.warn(e); }
        timer = setTimeout(tick, 150);
      };
      tick();
    })();
  });
}

const timeoutFetch = (url, ms = 8000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }).finally(() => clearTimeout(t));
};

async function imageBlob(url) {
  try {
    const res = await timeoutFetch(url, 10000);
    if (!res.ok) return null;
    const b = await res.blob();
    if (!/^image\//.test(b.type) || b.size < 1500) return null; // Platzhalterbilder (1×1) ignorieren
    return b;
  } catch (e) { return null; }
}

// → { isbn, title, author, cover (Blob|null), source } oder null
export async function lookupIsbn(isbn) {
  if (!navigator.onLine) throw new Error('Keine Internetverbindung');
  let found = null;
  try {
    const res = await timeoutFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    if (res.ok) {
      const j = await res.json();
      const d = j[`ISBN:${isbn}`];
      if (d && d.title) {
        found = {
          isbn, source: 'Open Library',
          title: d.subtitle && d.title.length < 40 ? `${d.title}. ${d.subtitle}` : d.title,
          author: (d.authors || []).map((a) => a.name).join(', '),
          coverUrl: d.cover ? d.cover.large || d.cover.medium : null,
        };
      }
    }
  } catch (e) { console.warn('Open Library', e); }
  if (!found) {
    try {
      const res = await timeoutFetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      if (res.ok) {
        const j = await res.json();
        const v = j.items && j.items[0] && j.items[0].volumeInfo;
        if (v && v.title) {
          const img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
          found = {
            isbn, source: 'Google Books',
            title: v.subtitle && v.title.length < 40 ? `${v.title}. ${v.subtitle}` : v.title,
            author: (v.authors || []).join(', '),
            coverUrl: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
          };
        }
      }
    } catch (e) { console.warn('Google Books', e); }
  }
  if (!found) return null;
  found.cover = found.coverUrl ? await imageBlob(found.coverUrl) : null;
  if (!found.cover) found.cover = await imageBlob(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`);
  return found;
}

// Kleiner Hinweis für den Dialog
export function privacyNote() {
  return h('p', { class: 'muted small' }, icon('search'), ' Zum Nachschlagen wird nur die ISBN an Open Library (Internet Archive) bzw. Google Books gesendet.');
}
