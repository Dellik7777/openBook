// Natürliche Vorlesestimme ohne Cloud: Piper-Stimmen (VITS) laufen direkt im Browser.
//
//  Text → Lautschrift (espeak-ng als WebAssembly) → Lautnummern → neuronales Sprachmodell
//  (ONNX Runtime als WebAssembly) → Audio. Alles auf dem Gerät, auch offline.
//
// Die Sprachmodelle sind groß (ca. 60 MB) und werden nur auf Wunsch einmal von Hugging Face
// geladen (dabei wird kein Text übertragen) und dann im Speicher der App aufbewahrt.

const CACHE = 'ob-voices-v1';
const HOSTS = [
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
  'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/',
];

// Freie deutsche Stimmen (Datensätze CC0 bzw. frei; siehe Modellkarten bei Hugging Face)
export const VOICES = {
  'de_DE-thorsten-medium': { name: 'Thorsten', desc: 'Männlich, natürlich (empfohlen)', path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium', mb: 63 },
  'de_DE-thorsten-low': { name: 'Thorsten (schnell)', desc: 'Männlich, etwas einfacher, rechnet schneller', path: 'de/de_DE/thorsten/low/de_DE-thorsten-low', mb: 63 },
  'de_DE-eva_k-x_low': { name: 'Eva (sehr schnell)', desc: 'Weiblich, klein, für ältere Geräte', path: 'de/de_DE/eva_k/x_low/de_DE-eva_k-x_low', mb: 21 },
  'de_DE-thorsten-high': { name: 'Thorsten (hoch)', desc: 'Männlich, beste Qualität, braucht viel Rechenzeit', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high', mb: 114 },
  'de_DE-kerstin-low': { name: 'Kerstin', desc: 'Weiblich', path: 'de/de_DE/kerstin/low/de_DE-kerstin-low', mb: 63 },
  'de_DE-ramona-low': { name: 'Ramona', desc: 'Weiblich', path: 'de/de_DE/ramona/low/de_DE-ramona-low', mb: 63 },
};

// Die Berechnung läuft in einem Web Worker (piper-worker.js) – sonst stünde die Oberfläche
// während jedes Satzes still (auf dem iPhone mehrere Sekunden).
let worker = null, seq = 0;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./piper-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Fehler in der Sprachberechnung');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}
function ask(msg) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

// ---------- Modelle laden und aufbewahren ----------

async function cached(id, ext) {
  try {
    const c = await caches.open(CACHE);
    return await c.match('/voices/' + id + ext);
  } catch (e) { return null; }
}

export async function isInstalled(id) {
  return !!(await cached(id, '.onnx')) && !!(await cached(id, '.onnx.json'));
}

export async function installed() {
  const out = [];
  for (const id of Object.keys(VOICES)) if (await isInstalled(id)) out.push(id);
  return out;
}

// Lädt eine Stimme herunter; onProgress(anteil 0..1)
export async function install(id, onProgress = () => {}, signal = null) {
  const v = VOICES[id];
  if (!v) throw new Error('Unbekannte Stimme');
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const cfg = await fetch(host + v.path + '.onnx.json', { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!cfg.ok) throw new Error('HTTP ' + cfg.status);
      const cfgText = await cfg.text();
      JSON.parse(cfgText);
      const res = await fetch(host + v.path + '.onnx', { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = +(res.headers.get('Content-Length') || 0) || v.mb * 1048576;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        onProgress(Math.min(0.99, got / total));
      }
      const c = await caches.open(CACHE);
      await c.put('/voices/' + id + '.onnx', new Response(new Blob(parts), { headers: { 'Content-Type': 'application/octet-stream' } }));
      await c.put('/voices/' + id + '.onnx.json', new Response(cfgText, { headers: { 'Content-Type': 'application/json' } }));
      onProgress(1);
      return;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Download fehlgeschlagen');
}

export async function remove(id) {
  if (worker) ask({ type: 'drop', voice: id }).catch(() => {}); // Speicher im Worker freigeben (nicht warten)
  try {
    const c = await caches.open(CACHE);
    await c.delete('/voices/' + id + '.onnx');
    await c.delete('/voices/' + id + '.onnx.json');
  } catch (e) { /* */ }
}

// ---------- Sprechen ----------

// Text → { samples: Float32Array, rate } (berechnet im Worker)
export async function synthesize(id, text, { rate = 1 } = {}) {
  const r = await ask({ type: 'synth', voice: id, text, rate });
  return { samples: r.samples, rate: r.rate };
}

// Wiedergabe über die Web-Audio-API. Auf dem iPhone als „Wiedergabe“ anmelden, damit der
// Stummschalter nicht stumm schaltet (Safari 17+).
// Wiedergabe über ein <audio>-Element (nicht Web Audio): Nur so zeigt iOS die Steuerung auf dem
// Sperrbildschirm und spielt weiter, wenn das Display ausgeht.
function wav(samples, rate) {
  const n = samples.length, dv = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
  }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}
const SILENCE = () => URL.createObjectURL(wav(new Float32Array(2205), 22050));

export function audioElement() {
  if (!window.__obAudioEl) {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    window.__obAudioEl = el;
  }
  return window.__obAudioEl;
}

// Muss direkt in der Tipp-Geste aufgerufen werden (iOS gibt Ton sonst nicht frei); ohne await davor.
export function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const el = audioElement();
    if (!el.__unlocked) {
      const u = SILENCE();
      el.src = u;
      const p = el.play();
      if (p && p.then) p.then(() => { el.__unlocked = true; }).catch(() => {});
      setTimeout(() => URL.revokeObjectURL(u), 2000);
    }
    return el;
  } catch (e) { return null; }
}

// Spielt Samples ab → { stop(), done: Promise<boolean (true = zu Ende gespielt)>, duration, position() }
export function play({ samples, rate }) {
  const el = audioElement();
  const url = URL.createObjectURL(wav(samples, rate));
  let finish;
  const done = new Promise((r) => { finish = r; });
  let over = false;
  const end = (ok) => {
    if (over) return;
    over = true;
    el.removeEventListener('ended', onEnded);
    el.removeEventListener('error', onError);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    finish(ok);
  };
  const onEnded = () => end(true);
  const onError = () => end(true); // nicht hängen bleiben
  el.addEventListener('ended', onEnded);
  el.addEventListener('error', onError);
  el.src = url;
  el.playbackRate = 1;
  const p = el.play();
  if (p && p.catch) p.catch((e) => { console.warn('Wiedergabe', e); end(false); });
  const duration = samples.length / rate;
  return {
    duration,
    position: () => el.currentTime || 0,
    stop() { if (!over) { try { el.pause(); } catch (e) { /* */ } end(false); } },
    done,
  };
}

export const supported = () => typeof WebAssembly === 'object' && 'caches' in window && typeof Worker === 'function';
