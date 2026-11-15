// Einzelne Seite: Foto ansehen, drehen, zuschneiden, verschieben, löschen, Text korrigieren.

import * as db from './db.js';
import { ensureBookAccess } from './lock.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, confirmDialog, UrlPool } from './ui.js';
import { rotate, crop, cropFigure, rewarp } from './imageproc.js';

export async function openPageEditor(root, bookId, pageId) {
  const pool = new UrlPool();
  let book = await db.getBook(bookId);
  let page = await db.getPage(pageId);
  if (!book || !page) { location.hash = `#/book/${bookId}`; return; }
  if (!(await ensureBookAccess(book))) { location.hash = '#/'; return; }

  const img = h('img', { class: 'pe-img', alt: 'Seitenfoto', draggable: 'false' });
  const cropBox = h('div', { class: 'crop-box', hidden: true });
  const figBoxes = h('div', { class: 'fig-boxes' });
  const imgWrap = h('div', { class: 'pe-imgwrap' }, img, figBoxes, cropBox);
  const figList = h('div', { class: 'fig-list' });
  const printedNo = h('input', { class: 'input pn-input', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '–', 'aria-label': 'Gedruckte Seitenzahl' });
  const pnHint = h('span', { class: 'muted small' });
  let cropMode = 'crop';
  const text = h('textarea', { class: 'input pe-text', spellcheck: 'true', lang: 'de', placeholder: 'Noch kein Text erkannt.' });
  const status = h('div', { class: 'muted small' });
  const checkBox = h('div', { class: 'uncertain', hidden: true });
  const title = h('div', { class: 'grow pe-title' });
  const cropOk = h('button', { class: 'btn small primary', onClick: () => endCrop(true) }, icon('check'), 'Zuschneiden');
  const cropBtns = h('div', { class: 'row gap-s', hidden: true },
    h('button', { class: 'btn small', onClick: () => endCrop(false) }, 'Abbrechen'),
    cropOk,
  );
  const noImage = h('div', { class: 'pe-noimage', hidden: true },
    h('p', {}, 'Kein Foto auf diesem Gerät'),
    h('p', { class: 'muted small' }, 'Diese Seite wurde auf einem anderen Gerät gescannt. Synchronisiert wird nur der Text; das Foto bleibt dort.'),
  );
  const imgTools = [
    h('button', { class: 'btn small', onClick: () => doRotate(-90) }, icon('rotate', 'flip'), 'Links'),
    h('button', { class: 'btn small', onClick: () => doRotate(90) }, icon('rotate'), 'Rechts'),
    h('button', { class: 'btn small', onClick: () => adjustCorners() }, icon('crop'), 'Ecken anpassen'),
    h('button', { class: 'btn small', onClick: () => startCrop('crop') }, icon('crop'), 'Zuschneiden'),
    h('button', { class: 'btn small', onClick: () => startCrop('figure') }, icon('figure'), 'Abbildung markieren'),
    h('button', { class: 'btn small', onClick: () => wholePageFigure() }, icon('image'), 'Ganze Seite ist Abbildung'),
  ];
  const rerunBtn = h('button', { class: 'btn small', onClick: () => rerun() }, icon('refresh'), 'Neu erkennen');
  const tools = h('div', { class: 'row gap-s wrap' },
    ...imgTools,
    h('button', { class: 'btn small', onClick: () => move(-1) }, icon('left'), 'Nach vorn'),
    h('button', { class: 'btn small', onClick: () => move(1) }, 'Nach hinten', icon('right')),
    rerunBtn,
    h('button', { class: 'btn small danger', onClick: () => remove() }, icon('trash'), 'Löschen'),
  );
  const prevBtn = iconButton('left', 'Vorherige Seite', () => step(-1));
  const nextBtn = iconButton('right', 'Nächste Seite', () => step(1));

  const view = h('div', { class: 'page pe' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück zum Buch', () => { location.hash = `#/book/${bookId}`; }),
      title, prevBtn, nextBtn,
    ),
    h('div', { class: 'pe-layout' },
      h('div', { class: 'pe-left' }, imgWrap, noImage, cropBtns, tools, figList),
      h('div', { class: 'pe-right' },
        h('label', { class: 'row gap-s pn-row' }, h('strong', {}, 'Gedruckte Seitenzahl'), printedNo, pnHint),
        h('div', { class: 'row between' }, h('strong', {}, 'Erkannter Text'), status),
        h('p', { class: 'muted small' }, 'Absätze mit einer Leerzeile trennen. Formatierung: **fett**, *kursiv*, „- “ am Anfang für Aufzählungen (je Ebene 2 Leerzeichen davor), „## “ für Überschriften. Änderungen werden automatisch gespeichert.'),
        checkBox,
        text,
      ),
    ),
  );
  root.append(view);

  function render() {
    const idx = book.pageOrder.indexOf(pageId);
    title.textContent = page.printedNo
      ? `Seite ${page.printedNo} · Foto ${idx + 1}/${book.pageOrder.length}`
      : `Foto ${idx + 1} von ${book.pageOrder.length}`;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= book.pageOrder.length - 1;
    pool.clear();
    const hasImg = !!page.image;
    imgWrap.hidden = !hasImg;
    noImage.hidden = hasImg;
    for (const b of [...imgTools, rerunBtn]) b.hidden = !hasImg;
    if (hasImg) img.src = pool.get(page.image);
    if (document.activeElement !== printedNo) printedNo.value = page.printedNo ?? '';
    pnHint.textContent = page.printedNoManual ? 'von Hand' : page.printedNo ? 'erkannt' : (page.ocrStatus === 'done' ? 'keine erkannt' : '');
    renderFigures();
    if (document.activeElement !== text) text.value = page.text || '';
    renderUncertain();
    const st = {
      pending: 'Wartet auf Erkennung',
      running: 'Text wird erkannt …',
      remote: 'Wird auf dem anderen Gerät erkannt',
      done: page.confidence != null ? `Erkannt · Sicherheit ${page.confidence} %` : 'Erkannt',
      error: 'Erkennung fehlgeschlagen',
    }[page.ocrStatus];
    status.textContent = st || '';
    text.disabled = ['running', 'pending', 'remote'].includes(page.ocrStatus);
  }

  // Unsichere Wörter: antippen springt zur Stelle im Text
  let searchFrom = 0;
  function renderUncertain() {
    const words = (page.uncertain || []).filter((w) => text.value.includes(w));
    checkBox.hidden = !words.length;
    if (!words.length) return;
    checkBox.replaceChildren(
      h('div', { class: 'row between' }, h('strong', { class: 'small' }, `Bitte prüfen: ${words.length} unsicher erkannte ${words.length === 1 ? 'Wort' : 'Wörter'}`),
        h('button', { class: 'linkish small', onClick: async () => { page = await db.updatePage(pageId, { uncertain: [] }); renderUncertain(); } }, 'Alle geprüft')),
      h('div', { class: 'tag-row' }, ...words.map((w) => h('button', { class: 'tag-chip warn', onClick: () => {
        let i = text.value.indexOf(w, searchFrom);
        if (i < 0) i = text.value.indexOf(w);
        if (i < 0) return;
        searchFrom = i + w.length;
        text.focus();
        text.setSelectionRange(i, i + w.length);
        // Auswahl in den sichtbaren Bereich scrollen
        const before = text.value.slice(0, i).split('\n').length;
        text.scrollTop = Math.max(0, (before - 3) * parseFloat(getComputedStyle(text).lineHeight || 24));
      } }, w))),
    );
  }
  text.addEventListener('input', () => { clearTimeout(text._ut); text._ut = setTimeout(renderUncertain, 500); });

  printedNo.addEventListener('change', async () => {
    const v = printedNo.value.trim();
    const n = parseInt(v, 10);
    page = await db.updatePage(pageId, v === '' ? { printedNo: null, printedNoManual: false } : { printedNo: Number.isFinite(n) && n > 0 ? n : null, printedNoManual: true });
    render();
  });

  // ---------- Abbildungen ----------
  let figures = [];
  const figPool = new UrlPool();
  async function renderFigures() {
    figures = (await db.getFiguresOfPage(pageId)).sort((a, b) => a.rect.y - b.rect.y);
    figPool.clear();
    figBoxes.replaceChildren(...figures.filter((f) => !f.fullPage).map((f, i) => h('div', {
      class: 'fig-box',
      style: { left: f.rect.x * 100 + '%', top: f.rect.y * 100 + '%', width: f.rect.w * 100 + '%', height: f.rect.h * 100 + '%' },
    }, h('span', {}, 'Abb. ' + (i + 1)))));
    if (!figures.length) { figList.replaceChildren(); return; }
    figList.replaceChildren(
      h('strong', {}, figures.length === 1 ? 'Abbildung auf dieser Seite' : `${figures.length} Abbildungen auf dieser Seite`),
      ...figures.map((f) => {
        const cap = h('input', { class: 'input', value: f.caption || '', placeholder: 'Bildunterschrift (optional)', onChange: (e) => db.updateFigure(f.id, { caption: e.target.value.trim() }) });
        return h('div', { class: 'fig-item' },
          h('img', { src: figPool.get(f.image), alt: f.caption || 'Abbildung' }),
          h('div', { class: 'grow stack-s' }, f.fullPage ? h('span', { class: 'muted small' }, 'Ganze Seite') : null, cap),
          iconButton('trash', 'Abbildung entfernen', async () => {
            if (!(await confirmDialog('Abbildung entfernen?', 'Die Abbildung erscheint dann nicht mehr im Lesetext. Das Seitenfoto bleibt erhalten.', 'Entfernen', true))) return;
            await db.deleteFigure(f.id);
            if (f.fullPage || page.text !== null) askRerun('Soll der Text dieser Seite jetzt neu erkannt werden (inklusive des bisher ausgeblendeten Bereichs)?');
            renderFigures();
          }, 'small'),
        );
      }),
    );
  }

  async function wholePageFigure() {
    if (figures.some((f) => f.fullPage)) { toast('Diese Seite ist schon als Abbildung markiert'); return; }
    if (page.text && !(await confirmDialog('Ganze Seite als Abbildung?', 'Die Seite erscheint im Lesetext als Bild. Der erkannte Text dieser Seite wird entfernt.', 'Übernehmen'))) return;
    const res = await cropFigure(page.image, { x: 0, y: 0, w: 1, h: 1 });
    await db.addFigure({ bookId, pageId, ...res, rect: { x: 0, y: 0, w: 1, h: 1 }, fullPage: true });
    page = await db.updatePage(pageId, { text: '', paraY: [], ocrStatus: 'done' });
    toast('Seite ist jetzt eine Abbildung');
    render();
  }

  let saveTimer = null;
  text.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  });
  async function save() {
    clearTimeout(saveTimer);
    const val = text.value.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (val === (page.text || '')) return;
    page = await db.updatePage(pageId, { text: val, ocrStatus: 'done' });
    status.textContent = 'Gespeichert';
  }

  // Drehen/Zuschneiden verschiebt die markierten Bereiche → Markierungen vorher entfernen
  async function confirmDropFigures() {
    const figs = await db.getFiguresOfPage(pageId);
    const marked = figs.filter((f) => !f.fullPage);
    if (!marked.length) return true;
    if (!(await confirmDialog('Abbildungen neu markieren?', 'Danach passen die markierten Abbildungen nicht mehr zum Foto. Sie werden entfernt und können neu markiert werden.', 'Weiter'))) return false;
    for (const f of marked) await db.deleteFigure(f.id);
    return true;
  }

  async function doRotate(deg) {
    if (!(await confirmDropFigures())) return;
    toast('Wird gedreht …');
    const r = await rotate(page.image, deg);
    page = await db.updatePage(pageId, { ...r });
    render();
    askRerun();
  }

  // Ecken frei einstellen: aus dem unbearbeiteten Original (falls vorhanden) neu entzerren,
  // sonst das aktuelle Foto perspektivisch zuschneiden
  async function adjustCorners() {
    const full = await db.getPage(pageId);
    const base = full.orig || full.image;
    if (!base) return;
    const { openCornerEditor } = await import('./corners.js');
    const { detectPage } = await import('./pagedetect.js');
    const fromOrig = !!full.orig;
    const quad = await openCornerEditor(base, fromOrig ? full.quad : null, {
      autoDetect: async () => {
        const bmp = await createImageBitmap(base);
        const d = detectPage(bmp);
        const res = d ? d.quad.map(([x, y]) => [x / bmp.width, y / bmp.height]) : null;
        bmp.close && bmp.close();
        return res;
      },
    });
    if (!quad) return;
    if (!(await confirmDropFigures())) return;
    toast('Seite wird neu entzerrt …');
    const r = await rewarp(base, quad, { scanFilter: fromOrig && full.filtered !== false });
    page = await db.updatePage(pageId, { ...r, ...(fromOrig ? { quad } : { orig: base, quad }) });
    render();
    askRerun();
  }

  async function askRerun(msg = 'Das Foto wurde geändert. Soll der Text dieser Seite neu erkannt werden?') {
    if (await confirmDialog('Text neu erkennen?', msg, 'Neu erkennen')) rerun(true);
  }

  async function rerun(skipConfirm = false) {
    if (!skipConfirm && page.text && !(await confirmDialog('Neu erkennen?', 'Der aktuelle Text dieser Seite wird ersetzt.', 'Neu erkennen'))) return;
    page = await db.updatePage(pageId, { ocrStatus: 'pending' });
    ocr.enqueue(pageId, { front: true });
    render();
  }

  async function remove() {
    if (!(await confirmDialog('Seite löschen?', 'Das Foto und der Text dieser Seite werden gelöscht.', 'Löschen', true))) return;
    const idx = book.pageOrder.indexOf(pageId);
    await db.deletePage(pageId);
    book = await db.getBook(bookId);
    const nextId = book.pageOrder[Math.min(idx, book.pageOrder.length - 1)];
    toast('Seite gelöscht');
    location.hash = nextId ? `#/page/${bookId}/${nextId}` : `#/book/${bookId}`;
  }

  async function move(dir) {
    book = await db.updateBook(bookId, (b) => {
      const order = [...b.pageOrder];
      const i = order.indexOf(pageId);
      const j = i + dir;
      if (j < 0 || j >= order.length) return {};
      [order[i], order[j]] = [order[j], order[i]];
      return { pageOrder: order };
    });
    render();
  }

  async function step(dir) {
    await save();
    const i = book.pageOrder.indexOf(pageId);
    const id = book.pageOrder[i + dir];
    if (id) location.hash = `#/page/${bookId}/${id}`;
  }

  // ---------- Zuschneiden ----------
  let cropRect = null, cropStart = null;
  function startCrop(mode) {
    cropMode = mode;
    cropOk.replaceChildren(icon('check'), mode === 'figure' ? 'Als Abbildung speichern' : 'Zuschneiden');
    cropBox.classList.toggle('figure', mode === 'figure');
    cropRect = mode === 'figure' ? { x: 0.15, y: 0.3, w: 0.7, h: 0.35 } : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    cropBox.hidden = false;
    cropBtns.hidden = false;
    tools.hidden = true;
    imgWrap.classList.add('cropping');
    drawCrop();
    toast(mode === 'figure' ? 'Rahmen um das Bild, die Karte oder das Diagramm ziehen' : 'Rahmen über den gewünschten Bereich ziehen');
  }
  function drawCrop() {
    Object.assign(cropBox.style, {
      left: cropRect.x * 100 + '%', top: cropRect.y * 100 + '%',
      width: cropRect.w * 100 + '%', height: cropRect.h * 100 + '%',
    });
  }
  function rel(e) {
    const r = img.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }
  imgWrap.addEventListener('pointerdown', (e) => {
    if (!cropRect) return;
    e.preventDefault();
    imgWrap.setPointerCapture(e.pointerId);
    cropStart = rel(e);
  });
  imgWrap.addEventListener('pointermove', (e) => {
    if (!cropRect || !cropStart) return;
    const p = rel(e);
    cropRect = {
      x: Math.min(cropStart.x, p.x), y: Math.min(cropStart.y, p.y),
      w: Math.abs(p.x - cropStart.x), h: Math.abs(p.y - cropStart.y),
    };
    drawCrop();
  });
  imgWrap.addEventListener('pointerup', () => { cropStart = null; });
  async function endCrop(apply) {
    const r = cropRect;
    cropRect = null;
    cropBox.hidden = true;
    cropBtns.hidden = true;
    tools.hidden = false;
    imgWrap.classList.remove('cropping');
    if (!apply || !r || r.w < 0.05 || r.h < 0.05) return;
    if (cropMode === 'figure') {
      const res = await cropFigure(page.image, r);
      await db.addFigure({ bookId, pageId, ...res, rect: r });
      toast('Abbildung gespeichert');
      render();
      if (page.text) askRerun('Soll der Text dieser Seite neu erkannt werden? Beschriftungen innerhalb der Abbildung landen dann nicht mehr im Lesetext.');
      return;
    }
    if (!(await confirmDropFigures())) return;
    toast('Wird zugeschnitten …');
    const res = await crop(page.image, r);
    page = await db.updatePage(pageId, { ...res });
    render();
    askRerun();
  }

  render();
  const off = db.onChange(async (e) => {
    if (e.type === 'figure' && e.bookId === bookId) { renderFigures(); return; }
    if (e.type === 'page' && e.id === pageId) {
      page = await db.getPage(pageId);
      if (page) render();
    } else if (e.bookId === bookId && e.type === 'book') {
      book = await db.getBook(bookId);
      if (book) render();
    }
  });

  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  document.addEventListener('keydown', onKey);

  return () => {
    save();
    off();
    document.removeEventListener('keydown', onKey);
    pool.clear();
    figPool.clear();
  };
}
