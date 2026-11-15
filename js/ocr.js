// Texterkennung (OCR) komplett auf dem Gerät mit Tesseract.js.
// Seiten werden in einer Warteschlange abgearbeitet; der Status steht in der DB,
// sodass nach einem Neustart der App automatisch weitergemacht wird.

import * as db from './db.js';
import { analyzeOcr } from './textproc.js';
import { grayImage, detectStyles } from './fontstyle.js';
import { dewarpText, findDropCap } from './dewarp.js';

const base = new URL('../vendor/tesseract/', import.meta.url).href;
// Nur Deutsch erkennt Umlaute deutlich zuverlässiger als Deutsch+Englisch (das englische
// Modell liest „ü“ gern als „ii“ und „ö“ als „6“). Englisch ist in den Einstellungen wählbar.
export const LANG_OPTIONS = { deu: 'Deutsch', 'deu+eng': 'Deutsch + Englisch', eng: 'Englisch' };
let LANGS = 'deu';
try { LANGS = localStorage.getItem('ob.langs') || LANGS; } catch (e) { /* */ }
export const getLanguages = () => LANGS;
export async function setLanguages(l) {
  if (!LANG_OPTIONS[l] || l === LANGS) return;
  LANGS = l;
  try { localStorage.setItem('ob.langs', l); } catch (e) { /* */ }
  // Worker mit den neuen Sprachen neu starten (sobald gerade keiner arbeitet)
  const old = workers.splice(0);
  workerInit = null;
  for (const w of old) w.worker.terminate().catch(() => {});
  pump();
}

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
        let psm = '3';
        try { psm = localStorage.getItem('ob.psm') || psm; } catch (e) { /* */ }
        await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '0' });
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
        const { input, height, width, gray, dropCap, canvas } = await prepareImage(page.image, figures);
        const { data } = await w.worker.recognize(input, {}, { blocks: true, text: true });
        if (dropCap) await applyDropCap(w.worker, canvas, dropCap, data);
        markStyles(data, gray);
        const res = analyzeOcr(data, { height });
        const patch = {
          text: res.paras.join('\n\n'),
          paraY: res.paraY,
          ocrStatus: 'done',
          confidence: Math.round(data.confidence || 0),
        };
        if (!page.printedNoManual) patch.printedNo = res.printedNo;
        patch.uncertain = uncertainWords(data, patch.text);
        patch.lines = lineBoxes(data, width, height);
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
// Außerdem: gewölbte Zeilen gerade ziehen und ein großes Anfangszeichen (Initiale) abtrennen.
async function prepareImage(blob, figures) {
  let bmp = null;
  try { bmp = await createImageBitmap(blob); } catch (e) { return { input: blob, height: 0, width: 0, gray: null }; }
  const { width, height } = bmp;
  let c = document.createElement('canvas');
  c.width = width; c.height = height;
  let ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  ctx.fillStyle = '#fff';
  for (const f of figures) {
    const r = f.rect;
    ctx.fillRect(r.x * width, r.y * height, r.w * width, r.h * height);
  }
  let changed = figures.length > 0;
  try {
    const dw = dewarpText(c);
    if (dw) { c = dw; ctx = c.getContext('2d'); changed = true; }
  } catch (e) { console.warn('Zeilen geradeziehen übersprungen', e); }
  let dropCap = null, capCanvas = null;
  try {
    dropCap = findDropCap(c);
    if (dropCap) {
      capCanvas = document.createElement('canvas');
      const pad = Math.round(dropCap.L * 0.4);
      capCanvas.width = Math.round(dropCap.x1 - dropCap.x0) + pad * 2;
      capCanvas.height = Math.round(dropCap.y1 - dropCap.y0) + pad * 2;
      const cc = capCanvas.getContext('2d');
      cc.fillStyle = '#fff'; cc.fillRect(0, 0, capCanvas.width, capCanvas.height);
      cc.drawImage(c, dropCap.x0, dropCap.y0, dropCap.x1 - dropCap.x0, dropCap.y1 - dropCap.y0, pad, pad, dropCap.x1 - dropCap.x0, dropCap.y1 - dropCap.y0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(dropCap.x0, dropCap.y0, dropCap.x1 - dropCap.x0, dropCap.y1 - dropCap.y0);
      changed = true;
    }
  } catch (e) { console.warn('Initiale übersprungen', e); dropCap = null; }
  let gray = null;
  try { gray = grayImage(c, width, height); } catch (e) { console.warn('Stil-Erkennung nicht möglich', e); }
  const input = changed ? await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92)) : blob;
  return { input, height, width, gray, dropCap, canvas: capCanvas };
}

// Initiale einzeln erkennen (ein Zeichen) und vor das erste Wort der Zeile daneben setzen
async function applyDropCap(worker, capCanvas, dc, data) {
  let letter = '';
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '10' });
    const r = await worker.recognize(capCanvas);
    letter = (r.data.text || '').trim();
  } catch (e) { console.warn('Initiale nicht erkannt', e); }
  finally {
    let psm = '3';
    try { psm = localStorage.getItem('ob.psm') || psm; } catch (e) { /* */ }
    await worker.setParameters({ tessedit_pageseg_mode: psm }).catch(() => {});
  }
  if (!/^\p{Lu}$/u.test(letter)) return;
  let best = null;
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    if (!line.bbox || !(line.words || []).length) continue;
    if (line.bbox.x0 < dc.x1 - dc.L * 0.5) continue;
    const dy = Math.abs(line.bbox.y0 - dc.y0);
    if (dy > dc.L * 0.8) continue;
    if (!best || dy < best.dy) best = { line, dy };
  }
  if (!best) return;
  const w0 = best.line.words[0];
  w0.text = letter + w0.text;
  best.line.text = letter + best.line.text;
  // Kapitelanfänge haben oft ungewöhnliche Wörter („Aufhööööören!“) → nicht als Rauschen verwerfen
  best.line.confidence = Math.max(best.line.confidence || 0, 70);
  for (const w of best.line.words) w.confidence = Math.max(w.confidence || 0, 70);
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
  if (debug) { window.__obStyleDebug = debug; window.__obOcrData = data; }
}

// Wörter, bei denen die Erkennung unsicher war (zum gezielten Nachprüfen im Editor)
function uncertainWords(data, text) {
  const out = new Set();
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const t = (w.text || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
          if (t.length < 3 || (w.confidence ?? 100) >= 62) continue;
          if (!/\p{L}/u.test(t)) continue;
          if (text && !text.includes(t)) continue; // z. B. Kopfzeile, die nicht im Text steht
          out.add(t);
          if (out.size >= 40) return [...out];
        }
      }
    }
  }
  return [...out];
}

// Lage jeder Textzeile (relativ 0..1) – für die unsichtbare Textebene im durchsuchbaren PDF
function lineBoxes(data, width, height) {
  if (!width || !height) return null;
  const out = [];
  const r = (v) => Math.round(v * 10000) / 10000;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const t = (line.text || '').replace(/\s+/g, ' ').trim();
        if (!t || !line.bbox) continue;
        out.push({ t, x0: r(line.bbox.x0 / width), y0: r(line.bbox.y0 / height), x1: r(line.bbox.x1 / width), y1: r(line.bbox.y1 / height) });
      }
    }
  }
  return out;
}
