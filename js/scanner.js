// Scanner: Kamera-Vorschau, schnelles Abfotografieren vieler Seiten hintereinander.

import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, pickFiles, UrlPool } from './ui.js';
import { processCapture, grabFrame, cropFigure } from './imageproc.js';
import { quality, motionProbe, analyzeFrame } from './pagedetect.js';

// Schwellwerte (Bewegung: mittlere Grauwert-Änderung pro Bildpunkt eines 64-px-Vorschaubilds)
const MOVE = 6, STILL = 2.2, STILL_MS = 700;
const SHARP_MIN = 20, DARK_MIN = 50;
const PROBLEM_TEXT = { unscharf: 'unscharf', 'zu dunkel': 'zu dunkel', finger: 'ein Finger liegt auf der Seite', angeschnitten: 'die Seite ist angeschnitten' };
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
  // Doppelseite: '0' einzeln, '1' immer teilen, 'auto' am Bild erkennen (Standard)
  let splitMode = localStorage.getItem('ob.split') || 'auto';
  if (!['0', '1', 'auto'].includes(splitMode)) splitMode = 'auto';
  const splitValue = () => (splitMode === 'auto' ? 'auto' : splitMode === '1');
  let split = splitMode === '1';
  const scanFilter = localStorage.getItem('ob.scanFilter') !== '0';
  const autoCrop = localStorage.getItem('ob.autoCrop') !== '0';
  let auto = false, autoState = 'settle', stillSince = 0, prevProbe = null, autoTimer = null;
  let refProbe = null, diffs = [], blurSince = 0;
  // „Ecken prüfen“: nach jedem Foto die erkannten Ecken zeigen und frei einstellen lassen
  let checkCorners = localStorage.getItem('ob.checkCorners') === '1';
  let editing = false;
  const captures = []; // je Aufnahme ein Array von pageIds (Doppelseite = 2)
  const session = { started: Date.now(), dupes: 0, problems: new Map() }; // für die Fertig-Prüfung
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

  const SPLIT_LABEL = { auto: 'Seiten: Auto', 1: 'Doppelseite', 0: 'Einzelseite' };
  const splitBtn = h('button', { class: 'chip' + (splitMode !== '0' ? ' on' : ''), onClick: () => {
    splitMode = { auto: '1', 1: '0', 0: 'auto' }[splitMode];
    split = splitMode === '1';
    localStorage.setItem('ob.split', splitMode);
    splitBtn.classList.toggle('on', splitMode !== '0');
    splitBtn.lastChild.textContent = SPLIT_LABEL[splitMode];
    guide.classList.toggle('split', split);
    toast({ auto: 'Automatisch: Lesepixel erkennt Einzel- und Doppelseiten selbst', 1: 'Doppelseite: jedes Foto wird in 2 Seiten geteilt', 0: 'Einzelseite' }[splitMode]);
  } }, icon('split'), h('span', {}, SPLIT_LABEL[splitMode]));

  const figBtn = h('button', { class: 'chip', onClick: () => setFigureMode(!figureMode) }, icon('figure'), 'Abbildung');
  const autoBtn = h('button', { class: 'chip', onClick: () => { if (!auto) unlockSound(); setAuto(!auto); } }, icon('play'), 'Blättern');
  const cornersBtn = h('button', { class: 'chip' + (checkCorners ? ' on' : ''), onClick: () => {
    checkCorners = !checkCorners;
    localStorage.setItem('ob.checkCorners', checkCorners ? '1' : '0');
    cornersBtn.classList.toggle('on', checkCorners);
    toast(checkCorners ? 'Ecken prüfen: nach jedem Foto kannst du den Ausschnitt einstellen' : 'Ecken werden automatisch erkannt');
  } }, icon('crop'), 'Ecken');
  const autoInfo = h('div', { class: 'scan-auto', hidden: true }, h('span', { class: 'scan-auto-text' }), h('span', { class: 'scan-auto-bar' }, h('span', {})));
  function setFigureMode(on) {
    figureMode = on;
    figBtn.classList.toggle('on', on);
    guide.classList.toggle('figure', on);
    if (on) toast('Nächstes Foto wird in Farbe als Abbildung gespeichert (Karte, Bild, Diagramm)');
  }

  // Kurze Töne als Rückmeldung (ohne aufs Display schauen zu müssen)
  let audioCtx = null;
  function unlockSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    } catch (e) { audioCtx = null; }
  }
  function beep(kind) {
    if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 20 : [40, 70, 40]);
    if (!audioCtx || !auto) return;
    try {
      const tones = kind === 'ok' ? [[880, 0, 0.09]] : kind === 'shot' ? [[1320, 0, 0.04]] : [[330, 0, 0.14], [262, 0.18, 0.18]];
      for (const [f, t, d] of tones) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine';
        const t0 = audioCtx.currentTime + t;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + d + 0.02);
      }
    } catch (e) { /* */ }
  }
  // Große Bestätigung „S. 45 ✓“ im Bild
  const badge = h('div', { class: 'scan-badge', hidden: true });
  let badgeTimer = null;
  function showBadge(text, bad = false) {
    badge.textContent = text;
    badge.classList.toggle('bad', bad);
    badge.hidden = false;
    badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { badge.hidden = true; }, 1800);
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
    h('div', { class: 'scan-stage', onClick: (e) => { if (e.target === video || e.target === guide) capture(); } }, video, guide, flashEl, message, badge),
    h('header', { class: 'scan-top' },
      iconButton('close', 'Scanner schließen', () => finish()),
      h('div', { class: 'scan-title' }, h('div', {}, book.title), counter),
      h('div', { class: 'row gap-s wrap end scan-chips' }, torchBtn, autoBtn, cornersBtn, figBtn, splitBtn),
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

  function capture({ fromAuto = false, force = false } = {}) {
    if (!video.videoWidth) return false;
    const frame = grabFrame(video);
    // Qualitätscheck: unscharf oder zu dunkel?
    const q = quality(frame);
    let problem = q.sharp < SHARP_MIN ? 'unscharf' : q.bright < DARK_MIN ? 'zu dunkel' : null;
    if (!problem && !figureMode) {
      try {
        const a = analyzeFrame(frame);
        problem = a.finger ? 'finger' : a.cut ? 'angeschnitten' : null;
      } catch (e) { /* ohne Prüfung */ }
    }
    if (problem && fromAuto && !force) return false; // Auto-Auslöser wartet kurz auf ein besseres Bild
    let soft = null;
    if (problem && fromAuto) { toast(`Foto: ${PROBLEM_TEXT[problem]} – Seite ggf. im Editor prüfen`); soft = problem; problem = null; } // Auto nicht anhalten, aber für die Fertig-Prüfung merken
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(15);
    beep('shot');
    if (checkCorners && !figureMode) { reviewCorners(frame, problem); return true; }
    enqueueProcessing(frame, problem, null, soft);
    return true;
  }

  async function reviewCorners(frame, problem) {
    editing = true;
    try {
      const { openCornerEditor } = await import('./corners.js');
      const { detectPage } = await import('./pagedetect.js');
      const detect = () => {
        const d = detectPage(frame, { spread: splitMode !== '0' });
        return d ? d.quad.map(([x, y]) => [x / frame.width, y / frame.height]) : null;
      };
      let q0 = null;
      try { q0 = autoCrop ? detect() : null; } catch (e) { /* von Hand */ }
      const quad = await openCornerEditor(frame, q0, { autoDetect: async () => detect(), title: splitMode === '1' ? 'Ecken der Doppelseite' : 'Ecken der Seite', okLabel: 'Seite übernehmen' });
      if (!quad) { toast('Foto verworfen'); return; }
      enqueueProcessing(frame, problem, quad);
    } finally {
      editing = false;
      prevProbe = null; stillSince = 0;
    }
  }

  // ---------- Auto-Auslöser: nach dem Umblättern auslösen, sobald das Bild ruhig ist ----------
  function setAuto(on) {
    auto = on;
    autoBtn.classList.toggle('on', on);
    autoInfo.hidden = !on;
    clearInterval(autoTimer);
    prevProbe = null; refProbe = null; diffs = []; stillSince = 0; blurSince = 0; autoState = 'settle';
    if (on) {
      toast('Blättermodus: Buch ruhig halten und einfach umblättern – Lesepixel fotografiert jede neue Seite selbst', 4000);
      autoTimer = setInterval(autoTick, 150);
    }
    showAuto();
  }
  function showAuto(progress = 0) {
    autoInfo.querySelector('.scan-auto-text').textContent = autoState === 'armed' ? 'Umblättern …' : 'Ruhig halten …';
    autoInfo.querySelector('.scan-auto-bar span').style.width = Math.round(progress * 100) + '%';
    autoInfo.classList.toggle('armed', autoState === 'armed');
  }
  // Schwellen passen sich dem Grundrauschen an (Handy in der Hand zittert immer etwas)
  function thresholds() {
    const sorted = [...diffs].sort((a, b) => a - b);
    const noise = sorted.length >= 6 ? sorted[Math.floor(sorted.length * 0.25)] : STILL / 2;
    const still = Math.min(9, Math.max(STILL, noise * 1.8 + 0.8));
    return { still, move: Math.max(MOVE, still * 2.5) };
  }
  function autoTick() {
    if (!auto || editing || !video.videoWidth || !notice.hidden) return; // bei offenen Hinweisen pausieren
    const { frame, diff } = motionProbe(video, prevProbe);
    prevProbe = frame;
    if (Number.isFinite(diff)) { diffs.push(diff); if (diffs.length > 30) diffs.shift(); }
    const thr = thresholds();
    if (autoState === 'armed') {
      // Umgeblättert? Bewegung zwischen zwei Bildern ODER deutlich anderes Bild als bei der letzten Aufnahme
      const fromRef = refProbe ? motionProbe(video, refProbe).diff : 0;
      if (diff > thr.move || fromRef > thr.move * 1.5) { autoState = 'moving'; stillSince = 0; }
      showAuto();
      return;
    }
    if (diff < thr.still) {
      if (!stillSince) stillSince = Date.now();
      const p = (Date.now() - stillSince) / STILL_MS;
      showAuto(Math.min(1, p));
      if (p >= 1) {
        // Bei unscharfem Bild bis zu 2,5 s auf ein besseres warten, dann trotzdem auslösen
        if (!blurSince) blurSince = Date.now();
        const force = Date.now() - blurSince > 2500;
        if (capture({ fromAuto: true, force })) { autoState = 'armed'; stillSince = 0; blurSince = 0; refProbe = frame; showAuto(); }
      }
    } else {
      stillSince = 0; blurSince = 0;
      showAuto();
    }
  }

  function enqueueProcessing(src, problem = null, quad = null, soft = null) {
    pendingCount++;
    updateCounter();
    const asFigure = figureMode;
    const doSplit = asFigure ? false : splitValue();
    if (asFigure) setFigureMode(false); // Abbildungsmodus gilt für ein Foto
    processing = processing.then(async () => {
      try {
        // Abbildungen in Farbe und ohne Scan-Filter
        const parts = await processCapture(src, { split: doSplit, scanFilter: scanFilter && !asFigure, autoCrop, quad });
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
          if (problem || soft) session.problems.set(page.id, problem || soft);
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
    if (!captures.length || doneShown) { location.hash = `#/book/${bookId}`; return; }
    openFinishCheck();
  }

  // ---------- Fertig-Prüfung: Ist das Buch vollständig und sauber? ----------
  let doneShown = false, finishEl = null, resumeAuto = false;
  async function openFinishCheck() {
    doneShown = true;
    resumeAuto = auto;
    if (auto) setAuto(false);
    const box = h('div', { class: 'finish-body' });
    finishEl = h('div', { class: 'finish-check', role: 'dialog', 'aria-label': 'Fertig-Prüfung' },
      h('div', { class: 'finish-head' }, h('h2', {}, 'Fertig-Prüfung'), iconButton('close', 'Weiter scannen', () => closeFinish())),
      box);
    view.append(finishEl);
    let stop = false;
    const render = async () => {
      if (stop || !finishEl) return;
      const b = await db.getBook(bookId);
      const pages = await db.getPagesMeta(bookId, { images: false });
      const mineIds = new Set(captures.flat());
      const mine = pages.filter((p) => mineIds.has(p.id));
      const waiting = mine.filter((p) => p.ocrStatus !== 'done' && p.ocrStatus !== 'error').length;
      if (waiting) {
        box.replaceChildren(
          h('p', {}, `Texterkennung läuft: ${mine.length - waiting} von ${mine.length} Seiten fertig …`),
          h('div', { class: 'progress big' }, h('div', { style: { width: Math.round((mine.length - waiting) / Math.max(1, mine.length) * 100) + '%' } })),
          h('p', { class: 'muted small' }, 'Danach prüft Lesepixel, ob Seiten fehlen, doppelt oder vertauscht sind und ob der Text sauber erkannt wurde.'),
          h('div', { class: 'row gap-s wrap' },
            h('button', { class: 'btn', onClick: () => closeFinish() }, icon('camera'), 'Weiter scannen'),
            h('button', { class: 'btn', onClick: () => { location.hash = `#/book/${bookId}`; } }, 'Nicht warten – zum Buch')));
        return;
      }
      const issues = checkPages(pages, { ignored: b.ignoredGaps || [] });
      const problems = [...session.problems].filter(([id]) => pages.some((p) => p.id === id));
      const { analyzeBook } = await import('./proofread.js');
      const proof = await analyzeBook(mine.filter((p) => p.text), { ignored: b.proofIgnore || [] });
      const nos = pages.map((p) => p.printedNo).filter(Boolean);
      const range = nos.length ? `Seiten ${Math.min(...nos)}–${Math.max(...nos)}` : `${pages.length} Seiten`;
      const fixable = new Set(proof.fixes.map((f) => f.from)).size, review = new Set(proof.review.map((r) => r.word)).size;
      const rows = [];
      const row = (ok, title, sub, ...actions) => rows.push(h('div', { class: 'finish-row' + (ok ? ' ok' : ' warn') },
        h('span', { class: 'finish-icon' }, ok ? '✓' : '!'),
        h('div', { class: 'grow' }, h('strong', {}, title), sub ? h('div', { class: 'muted small' }, sub) : null),
        actions.length ? h('div', { class: 'row gap-s wrap' }, ...actions) : null));
      row(true, `${mine.length} ${mine.length === 1 ? 'Seite' : 'Seiten'} neu gescannt`, `Buch jetzt: ${range}` + (session.dupes ? ` · ${session.dupes} doppelt fotografierte verworfen` : ''));
      const gaps = issues.filter((x) => x.type === 'missing');
      if (gaps.length) for (const is of gaps.slice(0, 4)) row(false, describe(is), null, h('button', { class: 'btn small primary', onClick: () => {
        insertAfter = is.afterPageId; insertLeft = Math.min(is.count, 20); updateInsertBar();
        // denselben Hinweis im Scanner nicht noch einmal zeigen (er hält sonst den Blättermodus an)
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === 'missing') queue.splice(i, 1);
        showNotice();
        closeFinish(); toast('Jetzt die fehlenden Seiten fotografieren');
      } }, icon('camera'), 'Nachscannen'));
      else row(true, 'Keine Lücken', nos.length >= 2 ? `${nos.length} von ${pages.length} Seitenzahlen erkannt` : 'Zu wenige Seitenzahlen für eine sichere Prüfung');
      const dupl = issues.filter((x) => x.type === 'duplicate'), order = issues.filter((x) => x.type === 'order');
      if (dupl.length) row(false, dupl.length === 1 ? describe(dupl[0]) : `${dupl.length} Seiten doppelt`, null, h('button', { class: 'btn small', onClick: () => { location.hash = `#/book/${bookId}`; } }, 'Im Buch ansehen'));
      if (order.length) row(false, 'Reihenfolge stimmt nicht überall', describe(order[0]), h('button', { class: 'btn small', onClick: () => { location.hash = `#/book/${bookId}`; } }, icon('sort'), 'Im Buch ordnen'));
      if (problems.length) row(false, `${problems.length} ${problems.length === 1 ? 'Foto' : 'Fotos'} mit Hinweis`, [...new Set(problems.map(([, p]) => PROBLEM_TEXT[p]))].join(', '),
        h('button', { class: 'btn small', onClick: () => { location.hash = `#/page/${bookId}/${problems[0][0]}`; } }, 'Ansehen'));
      else row(true, 'Fotos in Ordnung', 'Scharf, hell genug, nichts verdeckt');
      if (fixable || review) row(false, 'Textprüfung', [fixable ? (fixable === 1 ? '1 eindeutiger Lesefehler (wird korrigiert)' : `${fixable} eindeutige Lesefehler (werden korrigiert)`) : null, review ? (review === 1 ? '1 Wort zum Ansehen' : `${review} Wörter zum Ansehen`) : null].filter(Boolean).join(' · '),
        h('button', { class: 'btn small primary', onClick: () => { location.hash = `#/pruefen/${bookId}`; } }, icon('check'), 'Text prüfen'));
      else row(true, 'Text sauber erkannt', 'Keine zweifelhaften Wörter gefunden');
      const allOk = !gaps.length && !dupl.length && !order.length && !problems.length && !fixable && !review;
      box.replaceChildren(...[
        allOk ? h('div', { class: 'finish-hero' }, h('div', { class: 'finish-big' }, '✓'), h('h3', {}, 'Alles vollständig'), h('p', { class: 'muted' }, `${b.title}: ${range}`)) : null,
        ...rows,
        h('div', { class: 'row gap-s wrap finish-actions' },
          h('button', { class: 'btn primary', onClick: () => { location.hash = `#/book/${bookId}`; } }, icon('book'), 'Zum Buch'),
          h('button', { class: 'btn', onClick: () => closeFinish() }, icon('camera'), 'Weiter scannen')),
      ].filter(Boolean));
      if (allOk) beep('ok');
    };
    const off = db.onChange((e) => { if (e.bookId === bookId) { clearTimeout(rt); rt = setTimeout(render, 500); } });
    let rt = null;
    finishEl._off = () => { stop = true; off(); clearTimeout(rt); };
    render();
  }
  function closeFinish() {
    if (finishEl) { finishEl._off(); finishEl.remove(); finishEl = null; }
    doneShown = false;
    if (resumeAuto && !auto) setAuto(true);
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
    await announceDone(pages);
    const issues = checkPages(pages, { ignored: b.ignoredGaps || [], confirmedOnly: true });
    // Nur Probleme melden, an denen eine in dieser Sitzung gescannte Seite beteiligt ist
    const mine = new Set(captures.flat());
    const before = queue.length;
    for (const is of issues) {
      if (shown.has(is.key)) continue;
      const involved = [is.afterPageId, is.beforePageId, is.pageId, ...(is.pageIds || [])].filter(Boolean);
      if (!involved.some((id) => mine.has(id))) continue;
      shown.add(is.key);
      queue.push(is);
    }
    if (queue.length > before) beep('bad');
    // Bereits behobene Hinweise ausblenden
    const open = new Set(issues.map((x) => x.key));
    for (let i = queue.length - 1; i >= 0; i--) if (!open.has(queue[i].key)) queue.splice(i, 1);
    showNotice();
  }
  // Fertig erkannte Aufnahmen bestätigen („S. 45 ✓“) – doppelt fotografierte Seiten verwerfen
  const words = (t) => new Set((t || '').toLowerCase().match(/[a-zäöüß]{4,}/g) || []);
  const similar = (a, b) => {
    const A = words(a), B = words(b);
    if (A.size < 25 || B.size < 25) return false;
    let n = 0; for (const w of A) if (B.has(w)) n++;
    return n / (A.size + B.size - n) >= 0.75;
  };
  async function announceDone(pages) {
    for (const g of [...captures]) {
      if (g.announced || !g.length) continue;
      const ps = g.map((id) => pages.find((p) => p.id === id));
      if (ps.some((p) => !p || p.ocrStatus !== 'done')) continue;
      g.announced = true;
      const i0 = pages.indexOf(ps[0]);
      const prev = pages.slice(Math.max(0, i0 - 2), i0);
      if (ps.every((p) => prev.some((q) => similar(p.text, q.text)))) {
        for (const id of g) await db.deletePage(id);
        const gi = captures.indexOf(g); if (gi >= 0) captures.splice(gi, 1);
        session.dupes++;
        updateCounter();
        showBadge('Doppelt – verworfen', true);
        beep('bad');
        continue;
      }
      const nos = ps.map((p) => p.printedNo).filter(Boolean);
      showBadge(nos.length ? `S. ${nos.length > 1 ? nos[0] + '–' + nos[nos.length - 1] : nos[0]} ✓` : '✓ gespeichert');
      beep('ok');
    }
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
      const why = is.problem === 'finger' ? [h('strong', {}, 'Finger auf der Seite. '), 'Er verdeckt vielleicht Text.']
        : is.problem === 'angeschnitten' ? [h('strong', {}, 'Seite angeschnitten. '), 'Ein Teil liegt außerhalb des Bilds.']
          : [h('strong', {}, 'Foto ist ' + is.problem + '. '), 'Die Texterkennung wird dann ungenau.'];
      notice.replaceChildren(h('div', { class: 'scan-notice-text' }, ...why), h('div', { class: 'row gap-s wrap' }, ...buttons));
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
    if (finishEl) finishEl._off();
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
