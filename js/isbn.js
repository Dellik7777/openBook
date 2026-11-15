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
              if (!code) {
                // Mittelteil in voller Auflösung (Strichcode klein im Bild / Buch weiter weg)
                const cw = Math.min(vw, 1280), ch = Math.min(vh, Math.round(cw * 0.6));
                c.width = cw; c.height = ch;
                ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch);
                code = decodeEan13(grayFromCanvas(ctx, cw, ch), cw, ch);
              }
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

const join = (t, sub) => (sub && t.length < 40 && !t.includes(sub) ? `${t}. ${sub}` : t);
const isbn10of = (i13) => {
  if (!/^978\d{10}$/.test(i13)) return null;
  const b = i13.slice(3, 12);
  let s = 0;
  for (let i = 0; i < 9; i++) s += +b[i] * (10 - i);
  const c = (11 - (s % 11)) % 11;
  return b + (c === 10 ? 'X' : String(c));
};

// Quellen (alle parallel abgefragt; die erste mit Treffer in dieser Reihenfolge gewinnt)
const SOURCES = [
  ['Open Library', async (isbn) => {
    const res = await timeoutFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    if (!res.ok) return null;
    const d = (await res.json())[`ISBN:${isbn}`];
    return d && d.title ? { title: join(d.title, d.subtitle), author: (d.authors || []).map((a) => a.name).join(', '), coverUrl: d.cover ? d.cover.large || d.cover.medium : null } : null;
  }],
  ['Deutsche Nationalbibliothek', async (isbn) => {
    const res = await timeoutFetch(`https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=num%3D${isbn}&recordSchema=oai_dc&maximumRecords=1`);
    if (!res.ok) return null;
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const get = (tag) => [...xml.getElementsByTagName('*')].filter((e) => e.localName === tag).map((e) => e.textContent.trim());
    const title = (get('title')[0] || '').split(' / ')[0].replace(/\s*:\s*/, '. ').trim();
    if (!title) return null;
    const author = get('creator').map((c) => c.replace(/\s*\[.*?\]\s*/g, '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim()).filter(Boolean).join(', ');
    return { title, author, coverUrl: `https://portal.dnb.de/opac/mvb/cover?isbn=${isbn}` };
  }],
  ['lobid (hbz)', async (isbn) => {
    const res = await timeoutFetch(`https://lobid.org/resources/search?q=isbn:${isbn}&format=json&size=1`);
    if (!res.ok) return null;
    const m = ((await res.json()).member || [])[0];
    if (!m || !m.title) return null;
    const author = (m.contribution || []).map((c) => c.agent && c.agent.label).filter(Boolean).map((n) => n.replace(/^([^,]+),\s*(.+)$/, '$2 $1')).join(', ');
    return { title: join(m.title, m.otherTitleInformation && m.otherTitleInformation[0]), author, coverUrl: null };
  }],
  ['Google Books', async (isbn) => {
    const res = await timeoutFetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=DE`);
    if (!res.ok) return null;
    const v = ((await res.json()).items || [])[0];
    const vi = v && v.volumeInfo;
    if (!vi || !vi.title) return null;
    const img = vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail);
    return { title: join(vi.title, vi.subtitle), author: (vi.authors || []).join(', '), coverUrl: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null };
  }],
  ['Open Library', async (isbn) => {
    const res = await timeoutFetch(`https://openlibrary.org/search.json?isbn=${isbn}&fields=title,subtitle,author_name,cover_i&limit=1`);
    if (!res.ok) return null;
    const d = ((await res.json()).docs || [])[0];
    return d && d.title ? { title: join(d.title, d.subtitle), author: (d.author_name || []).join(', '), coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null } : null;
  }],
];

// → { isbn, title, author, cover (Blob|null), source } oder null
export async function lookupIsbn(isbn) {
  if (!navigator.onLine) throw new Error('Keine Internetverbindung');
  const results = await Promise.all(SOURCES.map(([name, fn]) => fn(isbn).then((r) => (r ? { ...r, source: name } : null)).catch((e) => { console.warn(name, e); return null; })));
  const hits = results.filter(Boolean);
  if (!hits.length) return null;
  const found = { isbn, ...hits[0] };
  if (!found.author) found.author = (hits.find((x) => x.author) || {}).author || '';
  // Cover: erste Quelle, deren Bild sich laden lässt
  found.cover = null;
  const urls = [...hits.map((x) => x.coverUrl).filter(Boolean), `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`];
  const i10 = isbn10of(isbn);
  if (i10) urls.push(`https://covers.openlibrary.org/b/isbn/${i10}-L.jpg?default=false`);
  for (const u of [...new Set(urls)]) { found.cover = await imageBlob(u); if (found.cover) break; }
  return found;
}

// Kleiner Hinweis für den Dialog
export function privacyNote() {
  return h('p', { class: 'muted small' }, icon('search'), ' Zum Nachschlagen wird nur die ISBN an Open Library, die Deutsche Nationalbibliothek, lobid (hbz) und Google Books gesendet.');
}
