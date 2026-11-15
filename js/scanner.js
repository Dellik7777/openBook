// Scanner: Kamera-Vorschau, schnelles Abfotografieren vieler Seiten hintereinander.

import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, pickFiles, UrlPool } from './ui.js';
import { processCapture, grabFrame, cropFigure } from './imageproc.js';
import { quality, motionProbe } from './pagedetect.js';

// Schwellwerte (Bewegung: mittlere Grauwert-Änderung pro Bildpunkt eines 64-px-Vorschaubilds)
const MOVE = 6, STILL = 2.2, STILL_MS = 700;
const SHARP_MIN = 20, DARK_MIN = 50;
import { checkPages, describe } from './pagecheck.js';

// afterPageId: Nachscan-Modus – neue Seiten werden hinter dieser Seite eingefügt
export async function openScanner(root, bookId, afterPageId = null, insertCount = 0) {
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
  const autoCrop = localStorage.getItem('ob.autoCrop') !== '0';
  let auto = false, autoState = 'settle', stillSince = 0, prevProbe = null, autoTimer = null;
  const captures = []; // je Aufnahme ein Array von pageIds (Doppelseite = 2)
  const capturedCount = () => captures.reduce((n, c) => n + c.length, 0);
  let processing = Promise.resolve();
  let pendingCount = 0;
  let figureMode = false;
  let insertAfter = afterPageId && book.pageOrder.includes(afterPageId) ? afterPageId : null;
  let insertLeft = insertAfter ? (insertCount || 1) : 0;

  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
  const guide = h('div', { class: 'scan-guide' + (split ? ' split' : '') });
  const flashEl = h('div', { class: 'scan-flash' });
  const counter = h('div', { class: 'scan-counter' });
  const lastThumb = h('button', { class: 'scan-thumb', 'aria-label': 'Fertig, zum Buch', onClick: () => finish() });
  const thumbLabel = h('span', { class: 'scan-thumb-label' }, 'Fertig');
  let lastId = null;
  const message = h('div', { class: 'scan-message', hidden: true });

  const splitBtn = h('button', { class: 'chip' + (split ? ' on' : ''), onClick: () => {
    split = !split;
    localStorage.setItem('ob.split', split ? '1' : '0');
    splitBtn.classList.toggle('on', split);
    guide.classList.toggle('split', split);
    toast(split ? 'Doppelseite: jedes Foto wird in 2 Seiten geteilt' : 'Einzelseite');
  } }, icon('split'), 'Doppelseite');

  const figBtn = h('button', { class: 'chip', onClick: () => setFigureMode(!figureMode) }, icon('figure'), 'Abbildung');
  const autoBtn = h('button', { class: 'chip', onClick: () => setAuto(!auto) }, icon('play'), 'Auto');
  const autoInfo = h('div', { class: 'scan-auto', hidden: true }, h('span', { class: 'scan-auto-text' }), h('span', { class: 'scan-auto-bar' }, h('span', {})));
  function setFigureMode(on) {
    figureMode = on;
    figBtn.classList.toggle('on', on);
    guide.classList.toggle('figure', on);
    if (on) toast('Nächstes Foto wird in Farbe als Abbildung gespeichert (Karte, Bild, Diagramm)');
  }

  // Hinweise zu fehlenden/doppelten Seiten und Nachscan-Modus
  const notice = h('div', { class: 'scan-notice', hidden: true });
  const insertBar = h('div', { class: 'scan-insert', hidden: true });

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
      h('div', { class: 'row gap-s wrap end scan-chips' }, torchBtn, autoBtn, figBtn, splitBtn),
    ),
    insertBar,
    notice,
    autoInfo,
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
  updateInsertBar();

  async function labelOf(pageId) {
    const order = (await db.getBook(bookId)).pageOrder;
    const p = await db.getPage(pageId);
    return p && p.printedNo ? `S. ${p.printedNo}` : `Foto ${order.indexOf(pageId) + 1}`;
  }

  async function updateInsertBar() {
    if (!insertAfter) { insertBar.hidden = true; return; }
    insertBar.hidden = false;
    insertBar.replaceChildren(
      h('span', {}, `Nachscannen: ${insertLeft > 1 ? insertLeft + ' Seiten' : 'Seite'} wird nach ${await labelOf(insertAfter)} eingefügt`),
      h('button', { class: 'chip', onClick: () => endInsert(true) }, 'Fertig'),
    );
  }
  function endInsert(manual = false) {
    insertAfter = null;
    insertLeft = 0;
    insertBar.hidden = true;
    if (!manual) toast('Lücke gefüllt – neue Fotos kommen wieder ans Ende');
  }

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMessage('Die Kamera ist hier nicht verfügbar. Nutze „Aus Galerie importieren“ oder öffne Lesepixel über HTTPS.');
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

  function capture({ fromAuto = false } = {}) {
    if (!video.videoWidth) return false;
    const frame = grabFrame(video);
    // Qualitätscheck: unscharf oder zu dunkel?
    const q = quality(frame);
    const problem = q.sharp < SHARP_MIN ? 'unscharf' : q.bright < DARK_MIN ? 'zu dunkel' : null;
    if (problem && fromAuto) return false; // Auto-Auslöser wartet auf ein besseres Bild
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(15);
    enqueueProcessing(frame, problem);
    return true;
  }

  // ---------- Auto-Auslöser: nach dem Umblättern auslösen, sobald das Bild ruhig ist ----------
  function setAuto(on) {
    auto = on;
    autoBtn.classList.toggle('on', on);
    autoInfo.hidden = !on;
    clearInterval(autoTimer);
    prevProbe = null; stillSince = 0; autoState = 'settle';
    if (on) {
      toast('Auto: Seite ruhig halten – nach dem Umblättern löst Lesepixel selbst aus');
      autoTimer = setInterval(autoTick, 150);
    }
    showAuto();
  }
  function showAuto(progress = 0) {
    autoInfo.querySelector('.scan-auto-text').textContent = autoState === 'armed' ? 'Umblättern …' : 'Ruhig halten …';
    autoInfo.querySelector('.scan-auto-bar span').style.width = Math.round(progress * 100) + '%';
    autoInfo.classList.toggle('armed', autoState === 'armed');
  }
  function autoTick() {
    if (!auto || !video.videoWidth || !notice.hidden) return; // bei offenen Hinweisen pausieren
    const { frame, diff } = motionProbe(video, prevProbe);
    prevProbe = frame;
    if (autoState === 'armed') {
      if (diff > MOVE) { autoState = 'moving'; stillSince = 0; }
      showAuto();
      return;
    }
    if (diff < STILL) {
      if (!stillSince) stillSince = Date.now();
      const p = (Date.now() - stillSince) / STILL_MS;
      showAuto(Math.min(1, p));
      if (p >= 1) {
        if (capture({ fromAuto: true })) { autoState = 'armed'; stillSince = 0; showAuto(); }
        else stillSince = Date.now(); // unscharf → weiter warten
      }
    } else {
      stillSince = 0;
      showAuto();
    }
  }

  function enqueueProcessing(src, problem = null) {
    pendingCount++;
    updateCounter();
    const asFigure = figureMode;
    const doSplit = split && !asFigure;
    if (asFigure) setFigureMode(false); // Abbildungsmodus gilt für ein Foto
    processing = processing.then(async () => {
      try {
        // Abbildungen in Farbe und ohne Scan-Filter
        const parts = await processCapture(src, { split: doSplit, scanFilter: scanFilter && !asFigure, autoCrop });
        const group = [];
        captures.push(group);
        for (const part of parts) {
          let at = null;
          const prevAfter = insertAfter;
          if (insertAfter) {
            const order = (await db.getBook(bookId)).pageOrder;
            const i = order.indexOf(insertAfter);
            at = i >= 0 ? i + 1 : null;
          }
          const page = await db.addPage(bookId, part, at);
          group.push(page.id);
          group.prevAfter = group.prevAfter || prevAfter;
          if (insertAfter) {
            insertAfter = page.id;
            insertLeft--;
            if (insertLeft <= 0) endInsert(); else updateInsertBar();
          }
          if (asFigure) {
            const fig = await cropFigure(part.image, { x: 0, y: 0, w: 1, h: 1 });
            await db.addFigure({ bookId, pageId: page.id, ...fig, rect: { x: 0, y: 0, w: 1, h: 1 }, fullPage: true });
            await db.updatePage(page.id, { text: '', paraY: [], ocrStatus: 'done' });
          } else {
            ocr.enqueue(page.id);
          }
          lastId = page.id;
          if (problem && part === parts[parts.length - 1]) {
            queue.unshift({ type: 'quality', key: 'q:' + page.id, group, problem });
            showNotice();
          }
          pool.clear();
          lastThumb.replaceChildren(h('img', { src: pool.get(part.thumb), alt: '' }), thumbLabel);
          thumbLabel.textContent = asFigure ? 'Abbildung' : 'Fertig';
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
    if (group.prevAfter !== undefined && (insertAfter && group.includes(insertAfter))) {
      insertAfter = group.prevAfter;
      insertLeft += group.length;
      updateInsertBar();
    }
    toast(group.length > 1 ? 'Letzte Doppelseite gelöscht' : 'Letzte Seite gelöscht');
    pool.clear();
    const lastGroup = captures[captures.length - 1];
    const prevId = lastGroup && lastGroup[lastGroup.length - 1];
    const prev = prevId ? await db.getPage(prevId) : null;
    lastId = prev ? prev.id : null;
    thumbLabel.textContent = prev && prev.printedNo ? `S. ${prev.printedNo}` : 'Fertig';
    lastThumb.replaceChildren(...(prev ? [h('img', { src: pool.get(prev.thumb), alt: '' }), thumbLabel] : []));
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

  // ---------- Seitenzahlen prüfen, sobald die Texterkennung fertig ist ----------
  const shown = new Set();
  const queue = [];
  let checkTimer = null;
  const offDb = db.onChange((e) => {
    if (e.bookId !== bookId || (e.type !== 'page' && e.type !== 'pages')) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, 400);
  });
  async function runCheck() {
    const b = await db.getBook(bookId);
    if (!b) return;
    const pages = await db.getPagesMeta(bookId, { images: false });
    // Seitenzahl der letzten Aufnahme am Vorschaubild anzeigen
    const last = pages.find((p) => p.id === lastId);
    if (last && last.printedNo && !thumbLabel.textContent.startsWith('Abb')) thumbLabel.textContent = `S. ${last.printedNo}`;
    const issues = checkPages(pages, { ignored: b.ignoredGaps || [], confirmedOnly: true });
    // Nur Probleme melden, an denen eine in dieser Sitzung gescannte Seite beteiligt ist
    const mine = new Set(captures.flat());
    for (const is of issues) {
      if (shown.has(is.key)) continue;
      const involved = [is.afterPageId, is.beforePageId, is.pageId, ...(is.pageIds || [])].filter(Boolean);
      if (!involved.some((id) => mine.has(id))) continue;
      shown.add(is.key);
      queue.push(is);
    }
    // Bereits behobene Hinweise ausblenden
    const open = new Set(issues.map((x) => x.key));
    for (let i = queue.length - 1; i >= 0; i--) if (!open.has(queue[i].key)) queue.splice(i, 1);
    showNotice();
  }
  function showNotice() {
    const is = queue[0];
    if (!is) { notice.hidden = true; return; }
    const next = () => { queue.shift(); showNotice(); };
    const ignore = async () => {
      await db.updateBook(bookId, (b) => ({ ignoredGaps: [...new Set([...(b.ignoredGaps || []), is.key])] }));
      next();
    };
    const buttons = [];
    if (is.type === 'quality') {
      buttons.push(h('button', { class: 'btn small primary', onClick: async () => {
        for (const id of is.group) await db.deletePage(id);
        const gi = captures.indexOf(is.group); if (gi >= 0) captures.splice(gi, 1);
        updateCounter(); next(); toast('Gelöscht – bitte nochmal fotografieren');
      } }, icon('camera'), 'Nochmal'));
      buttons.push(h('button', { class: 'btn small', onClick: next }, 'Behalten'));
      notice.hidden = false;
      notice.replaceChildren(h('div', { class: 'scan-notice-text' }, h('strong', {}, 'Foto ist ' + is.problem + '. '), 'Die Texterkennung wird dann ungenau.'), h('div', { class: 'row gap-s wrap' }, ...buttons));
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      return;
    }
    if (is.type === 'missing') {
      buttons.push(h('button', { class: 'btn small primary', onClick: () => {
        insertAfter = is.afterPageId; insertLeft = is.count; updateInsertBar(); next();
        toast('Jetzt die fehlende Seite fotografieren');
      } }, icon('camera'), 'Nachscannen'));
      buttons.push(h('button', { class: 'btn small', onClick: ignore }, 'Passt so'));
    } else if (is.type === 'duplicate') {
      buttons.push(h('button', { class: 'btn small primary', onClick: async () => {
        await db.deletePage(is.pageIds[1]);
        for (const g of captures) { const i = g.indexOf(is.pageIds[1]); if (i >= 0) g.splice(i, 1); }
        updateCounter(); toast('Doppelte Seite gelöscht'); next();
      } }, icon('trash'), 'Doppelte löschen'));
      buttons.push(h('button', { class: 'btn small', onClick: ignore }, 'Behalten'));
    } else {
      buttons.push(h('button', { class: 'btn small', onClick: ignore }, 'Passt so'));
      buttons.push(h('button', { class: 'btn small', onClick: next }, 'Später prüfen'));
    }
    notice.hidden = false;
    notice.replaceChildren(h('div', { class: 'scan-notice-text' }, h('strong', {}, 'Achtung: '), describe(is)), h('div', { class: 'row gap-s wrap' }, ...buttons));
    if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
  }

  start();

  return () => {
    offDb();
    clearInterval(autoTimer);
    clearTimeout(checkTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (wakeLock) wakeLock.release().catch(() => {});
    pool.clear();
  };
}
