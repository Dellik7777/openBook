// Texterkennung (OCR) komplett auf dem Gerät mit Tesseract.js.
// Seiten werden in einer Warteschlange abgearbeitet; der Status steht in der DB,
// sodass nach einem Neustart der App automatisch weitergemacht wird.

import * as db from './db.js';
import { analyzeOcr } from './textproc.js';
import { grayImage, detectStyles } from './fontstyle.js';

const base = new URL('../vendor/tesseract/', import.meta.url).href;
const LANGS = 'deu+eng';

let scriptPromise = null;
function loadScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => { scriptPromise = null; reject(new Error('OCR-Modul konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

const queue = [];          // pageIds
const active = new Set();  // pageIds in Bearbeitung
const workers = [];        // { worker, busy }
let workerInit = null;
let paused = false;
const listeners = new Set();

const MAX_WORKERS = Math.min(2, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 3)));

function notify() {
  const s = status();
  for (const fn of listeners) try { fn(s); } catch (e) { console.error(e); }
}

export function onStatus(fn) {
  listeners.add(fn);
  fn(status());
  return () => listeners.delete(fn);
}

export function status() {
  return { queued: queue.length, active: active.size, total: queue.length + active.size, paused };
}

async function ensureWorkers() {
  if (workers.length) return;
  if (!workerInit) {
    workerInit = (async () => {
      await loadScript();
      for (let i = 0; i < MAX_WORKERS; i++) {
        const worker = await window.Tesseract.createWorker(LANGS, 1 /* nur LSTM */, {
          workerPath: base + 'worker.min.js',
          corePath: base + 'core/',
          langPath: base + 'lang/',
          workerBlobURL: false,
          gzip: true,
        });
        // Buchseiten: automatische Seitensegmentierung, Wortabstände erhalten
        await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '0' });
        workers.push({ worker, busy: false });
      }
    })().catch((e) => { workerInit = null; throw e; });
  }
  await workerInit;
}

export function enqueue(pageId, { front = false } = {}) {
  if (active.has(pageId) || queue.includes(pageId)) return;
  if (front) queue.unshift(pageId); else queue.push(pageId);
  notify();
  pump();
}

export function setPaused(v) {
  paused = v;
  notify();
  if (!paused) pump();
}

let pumping = false;
async function pump() {
  if (pumping || paused) return;
  pumping = true;
  try {
    if (!queue.length) return;
    try {
      await ensureWorkers();
    } catch (e) {
      console.error(e);
      pumping = false;
      setTimeout(pump, 10000); // später erneut versuchen
      return;
    }
    for (const w of workers) {
      if (!w.busy && queue.length && !paused) runOn(w);
    }
  } finally {
    pumping = false;
  }
}

async function runOn(w) {
  const pageId = queue.shift();
  if (!pageId) return;
  w.busy = true;
  active.add(pageId);
  notify();
  try {
    const page = await db.getPage(pageId);
    if (page && page.image) {
      await db.updatePage(pageId, { ocrStatus: 'running' });
      const figures = await db.getFiguresOfPage(pageId);
      if (figures.some((f) => f.fullPage)) {
        // Ganze Seite ist eine Abbildung → kein Text
        await db.updatePage(pageId, { text: '', ocrStatus: 'done', paraY: [] });
      } else {
        const { input, height, gray } = await prepareImage(page.image, figures);
        const { data } = await w.worker.recognize(input, {}, { blocks: true, text: true });
        markStyles(data, gray);
        const res = analyzeOcr(data, { height });
        const patch = {
          text: res.paras.join('\n\n'),
          paraY: res.paraY,
          ocrStatus: 'done',
          confidence: Math.round(data.confidence || 0),
        };
        if (!page.printedNoManual) patch.printedNo = res.printedNo;
        await db.updatePage(pageId, patch);
      }
    }
  } catch (e) {
    console.error('OCR-Fehler', e);
    await db.updatePage(pageId, { ocrStatus: 'error' }).catch(() => {});
  } finally {
    active.delete(pageId);
    w.busy = false;
    notify();
    if (queue.length && !paused) runOn(w);
  }
}

// Beim Start: unerledigte Seiten wieder einreihen
export async function resume() {
  const pending = await db.getPagesByStatus('pending');
  const running = await db.getPagesByStatus('running');
  for (const id of [...running, ...pending]) enqueue(id);
}

export function isQueued(pageId) {
  return queue.includes(pageId) || active.has(pageId);
}

// Bildgröße ermitteln, Graustufenbild für die Fett/Kursiv-Erkennung erzeugen
// und markierte Abbildungen weiß übermalen, damit deren Beschriftungen nicht im Lesetext landen.
async function prepareImage(blob, figures) {
  let bmp = null;
  try { bmp = await createImageBitmap(blob); } catch (e) { return { input: blob, height: 0, gray: null }; }
  const { width, height } = bmp;
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  ctx.fillStyle = '#fff';
  for (const f of figures) {
    const r = f.rect;
    ctx.fillRect(r.x * width, r.y * height, r.w * width, r.h * height);
  }
  let gray = null;
  try { gray = grayImage(c, width, height); } catch (e) { console.warn('Stil-Erkennung nicht möglich', e); }
  const input = figures.length ? await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9)) : blob;
  return { input, height, gray };
}

// Fett/kursiv je Wort bestimmen (setzt word.bold / word.italic im OCR-Ergebnis)
function markStyles(data, gray) {
  if (!gray) return;
  const words = [];
  let lineId = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        lineId++;
        const lineH = line.bbox ? line.bbox.y1 - line.bbox.y0 : 0;
        for (const wd of line.words || []) {
          if (!wd.bbox || !wd.text) continue;
          wd.lineH = lineH; wd.lineId = lineId;
          words.push(wd);
        }
      }
    }
  }
  let debug = null;
  try { if (localStorage.getItem('ob.debug')) debug = []; } catch (e) { /* ignorieren */ }
  try { detectStyles(gray, words, 1, debug); } catch (e) { console.warn('Stil-Erkennung fehlgeschlagen', e); }
  if (debug) window.__obStyleDebug = debug;
}
