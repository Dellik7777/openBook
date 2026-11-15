// Scanner: Kamera-Vorschau, schnelles Abfotografieren vieler Seiten hintereinander.

import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, pickFiles, UrlPool } from './ui.js';
import { processCapture, grabFrame } from './imageproc.js';

export async function openScanner(root, bookId) {
  const book = await db.getBook(bookId);
  if (!book) { location.hash = '#/'; return; }
  document.body.classList.add('dark-ui');

  const pool = new UrlPool();
  let stream = null;
  let track = null;
  let torchOn = false;
  let wakeLock = null;
  let split = localStorage.getItem('ob.split') === '1';
  const scanFilter = localStorage.getItem('ob.scanFilter') !== '0';
  const captures = []; // je Aufnahme ein Array von pageIds (Doppelseite = 2)
  const capturedCount = () => captures.reduce((n, c) => n + c.length, 0);
  let processing = Promise.resolve();
  let pendingCount = 0;

  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
  const guide = h('div', { class: 'scan-guide' + (split ? ' split' : '') });
  const flashEl = h('div', { class: 'scan-flash' });
  const counter = h('div', { class: 'scan-counter' });
  const lastThumb = h('button', { class: 'scan-thumb', 'aria-label': 'Fertig, zum Buch', onClick: () => finish() });
  const message = h('div', { class: 'scan-message', hidden: true });

  const splitBtn = h('button', { class: 'chip' + (split ? ' on' : ''), onClick: () => {
    split = !split;
    localStorage.setItem('ob.split', split ? '1' : '0');
    splitBtn.classList.toggle('on', split);
    guide.classList.toggle('split', split);
    toast(split ? 'Doppelseite: jedes Foto wird in 2 Seiten geteilt' : 'Einzelseite');
  } }, icon('split'), 'Doppelseite');

  const torchBtn = h('button', { class: 'chip', hidden: true, onClick: async () => {
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    torchBtn.classList.toggle('on', torchOn);
  } }, icon('flash'), 'Licht');

  const shutter = h('button', { class: 'shutter', 'aria-label': 'Foto aufnehmen', onClick: () => capture() });

  const view = h('div', { class: 'scanner' },
    h('div', { class: 'scan-stage', onClick: (e) => { if (e.target === video || e.target === guide) capture(); } }, video, guide, flashEl, message),
    h('header', { class: 'scan-top' },
      iconButton('close', 'Scanner schließen', () => finish()),
      h('div', { class: 'scan-title' }, h('div', {}, book.title), counter),
      h('div', { class: 'row gap-s' }, torchBtn, splitBtn),
    ),
    h('footer', { class: 'scan-bottom' },
      h('button', { class: 'scan-side', onClick: () => undo(), 'aria-label': 'Letzte Aufnahme löschen' }, icon('undo'), h('span', {}, 'Zurück')),
      shutter,
      lastThumb,
    ),
    h('div', { class: 'scan-alt' },
      h('button', { class: 'linkish', onClick: () => importFiles() }, icon('images'), ' Aus Galerie importieren'),
    ),
  );
  root.append(view);
  updateCounter();

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMessage('Die Kamera ist hier nicht verfügbar. Nutze „Aus Galerie importieren“ oder öffne openBook über HTTPS.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) torchBtn.hidden = false;
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch (e) { /* optional */ }
      await video.play().catch(() => {});
    } catch (e) {
      console.error(e);
      showMessage(e.name === 'NotAllowedError'
        ? 'Kein Kamerazugriff. Erlaube die Kamera in den Browser-Einstellungen oder importiere Fotos aus der Galerie.'
        : 'Kamera konnte nicht gestartet werden: ' + e.message);
    }
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* optional */ }
  }

  function showMessage(text) {
    message.hidden = false;
    message.replaceChildren(h('p', {}, text), h('button', { class: 'btn primary', onClick: () => importFiles() }, icon('images'), 'Fotos importieren'));
  }

  function updateCounter() {
    const added = capturedCount();
    const total = book.pageOrder.length + added;
    counter.textContent = `${total} ${total === 1 ? 'Seite' : 'Seiten'}` + (added ? ` · +${added} neu` : '') + (pendingCount ? ' · speichert …' : '');
  }

  function capture() {
    if (!video.videoWidth) return;
    const frame = grabFrame(video);
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(15);
    enqueueProcessing(frame);
  }

  function enqueueProcessing(src) {
    pendingCount++;
    updateCounter();
    const doSplit = split;
    processing = processing.then(async () => {
      try {
        const parts = await processCapture(src, { split: doSplit, scanFilter });
        const group = [];
        captures.push(group);
        for (const part of parts) {
          const page = await db.addPage(bookId, part);
          group.push(page.id);
          ocr.enqueue(page.id);
          pool.clear();
          lastThumb.replaceChildren(h('img', { src: pool.get(part.thumb), alt: '' }), h('span', { class: 'scan-thumb-label' }, 'Fertig'));
        }
      } catch (e) {
        console.error(e);
        toast('Foto konnte nicht gespeichert werden');
      } finally {
        pendingCount--;
        updateCounter();
      }
    });
  }

  async function importFiles() {
    const files = await pickFiles({ multiple: true });
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.lastModified - b.lastModified);
    for (const f of files) enqueueProcessing(f);
  }

  async function undo() {
    await processing;
    const group = captures.pop();
    if (!group) { toast('Nichts zum Zurücknehmen'); return; }
    for (const id of group) await db.deletePage(id); // Doppelseite: beide Hälften
    toast(group.length > 1 ? 'Letzte Doppelseite gelöscht' : 'Letzte Seite gelöscht');
    pool.clear();
    const lastGroup = captures[captures.length - 1];
    const prevId = lastGroup && lastGroup[lastGroup.length - 1];
    const prev = prevId ? await db.getPage(prevId) : null;
    lastThumb.replaceChildren(...(prev ? [h('img', { src: pool.get(prev.thumb), alt: '' }), h('span', { class: 'scan-thumb-label' }, 'Fertig')] : []));
    updateCounter();
  }

  async function finish() {
    await processing;
    location.hash = `#/book/${bookId}`;
  }

  const onKey = (e) => {
    if (e.code === 'Space' || e.key === 'Enter' || e.key === 'AudioVolumeUp' || e.key === 'VolumeUp') { e.preventDefault(); capture(); }
  };
  document.addEventListener('keydown', onKey);
  const onVis = async () => {
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator && !wakeLock) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    }
  };
  document.addEventListener('visibilitychange', onVis);

  start();

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (wakeLock) wakeLock.release().catch(() => {});
    pool.clear();
  };
}
