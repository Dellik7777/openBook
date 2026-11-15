// Einzelne Seite: Foto ansehen, drehen, zuschneiden, verschieben, löschen, Text korrigieren.

import * as db from './db.js';
import * as ocr from './ocr.js';
import { h, icon, iconButton, toast, confirmDialog, UrlPool } from './ui.js';
import { rotate, crop } from './imageproc.js';

export async function openPageEditor(root, bookId, pageId) {
  const pool = new UrlPool();
  let book = await db.getBook(bookId);
  let page = await db.getPage(pageId);
  if (!book || !page) { location.hash = `#/book/${bookId}`; return; }

  const img = h('img', { class: 'pe-img', alt: 'Seitenfoto', draggable: 'false' });
  const cropBox = h('div', { class: 'crop-box', hidden: true });
  const imgWrap = h('div', { class: 'pe-imgwrap' }, img, cropBox);
  const text = h('textarea', { class: 'input pe-text', spellcheck: 'true', lang: 'de', placeholder: 'Noch kein Text erkannt.' });
  const status = h('div', { class: 'muted small' });
  const title = h('div', { class: 'grow pe-title' });
  const cropBtns = h('div', { class: 'row gap-s', hidden: true },
    h('button', { class: 'btn small', onClick: () => endCrop(false) }, 'Abbrechen'),
    h('button', { class: 'btn small primary', onClick: () => endCrop(true) }, icon('check'), 'Zuschneiden'),
  );
  const noImage = h('div', { class: 'pe-noimage', hidden: true },
    h('p', {}, 'Kein Foto auf diesem Gerät'),
    h('p', { class: 'muted small' }, 'Diese Seite wurde auf einem anderen Gerät gescannt. Synchronisiert wird nur der Text; das Foto bleibt dort.'),
  );
  const imgTools = [
    h('button', { class: 'btn small', onClick: () => doRotate(-90) }, icon('rotate', 'flip'), 'Links'),
    h('button', { class: 'btn small', onClick: () => doRotate(90) }, icon('rotate'), 'Rechts'),
    h('button', { class: 'btn small', onClick: () => startCrop() }, icon('crop'), 'Zuschneiden'),
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
      h('div', { class: 'pe-left' }, imgWrap, noImage, cropBtns, tools),
      h('div', { class: 'pe-right' },
        h('div', { class: 'row between' }, h('strong', {}, 'Erkannter Text'), status),
        h('p', { class: 'muted small' }, 'Absätze mit einer Leerzeile trennen. Änderungen werden automatisch gespeichert.'),
        text,
      ),
    ),
  );
  root.append(view);

  function render() {
    const idx = book.pageOrder.indexOf(pageId);
    title.textContent = `Seite ${idx + 1} von ${book.pageOrder.length}`;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= book.pageOrder.length - 1;
    pool.clear();
    const hasImg = !!page.image;
    imgWrap.hidden = !hasImg;
    noImage.hidden = hasImg;
    for (const b of [...imgTools, rerunBtn]) b.hidden = !hasImg;
    if (hasImg) img.src = pool.get(page.image);
    if (document.activeElement !== text) text.value = page.text || '';
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

  async function doRotate(deg) {
    toast('Wird gedreht …');
    const r = await rotate(page.image, deg);
    page = await db.updatePage(pageId, { ...r });
    render();
    askRerun();
  }

  async function askRerun() {
    if (await confirmDialog('Text neu erkennen?', 'Das Foto wurde geändert. Soll der Text dieser Seite neu erkannt werden?', 'Neu erkennen')) rerun(true);
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
  function startCrop() {
    cropRect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    cropBox.hidden = false;
    cropBtns.hidden = false;
    tools.hidden = true;
    imgWrap.classList.add('cropping');
    drawCrop();
    toast('Rahmen über den gewünschten Bereich ziehen');
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
    toast('Wird zugeschnitten …');
    const res = await crop(page.image, r);
    page = await db.updatePage(pageId, { ...res });
    render();
    askRerun();
  }

  render();
  const off = db.onChange(async (e) => {
    if (e.type === 'page' && e.id === pageId) {
      page = await db.getPage(pageId);
      if (page) render();
    } else if (e.bookId === bookId && e.type === 'book') {
      book = await db.getBook(bookId);
      if (book) render();
    }
  });

  const onKey = (e) => {
    if (e.target === text) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  document.addEventListener('keydown', onKey);

  return () => {
    save();
    off();
    document.removeEventListener('keydown', onKey);
    pool.clear();
  };
}
