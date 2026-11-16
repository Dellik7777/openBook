// Natürliche Vorlesestimme ohne Cloud: Piper-Stimmen (VITS) laufen direkt im Browser.
//
//  Text → Lautschrift (espeak-ng als WebAssembly) → Lautnummern → neuronales Sprachmodell
//  (ONNX Runtime als WebAssembly) → Audio. Alles auf dem Gerät, auch offline.
//
// Die Sprachmodelle sind groß (ca. 60 MB) und werden nur auf Wunsch einmal von Hugging Face
// geladen (dabei wird kein Text übertragen) und dann im Speicher der App aufbewahrt.

const base = new URL('../vendor/', import.meta.url).href;
const CACHE = 'ob-voices-v1';
const HOSTS = [
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
  'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/',
];

// Freie deutsche Stimmen (Datensätze CC0 bzw. frei; siehe Modellkarten bei Hugging Face)
export const VOICES = {
  'de_DE-thorsten-medium': { name: 'Thorsten', desc: 'Männlich, natürlich (empfohlen)', path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium', mb: 63 },
  'de_DE-thorsten-high': { name: 'Thorsten (hoch)', desc: 'Männlich, beste Qualität, braucht mehr Rechenzeit', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high', mb: 114 },
  'de_DE-kerstin-low': { name: 'Kerstin', desc: 'Weiblich', path: 'de/de_DE/kerstin/low/de_DE-kerstin-low', mb: 63 },
  'de_DE-ramona-low': { name: 'Ramona', desc: 'Weiblich', path: 'de/de_DE/ramona/low/de_DE-ramona-low', mb: 63 },
};

let ortPromise = null;
function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortPromise) {
    ortPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'ort/ort.wasm.min.js';
      s.onload = () => {
        const o = window.ort;
        o.env.wasm.wasmPaths = base + 'ort/';
        o.env.wasm.numThreads = 1; // ohne Cross-Origin-Isolation gibt es keine Threads
        o.env.wasm.simd = true;
        resolve(o);
      };
      s.onerror = () => { ortPromise = null; reject(new Error('Sprachmodul konnte nicht geladen werden')); };
      document.head.append(s);
    });
  }
  return ortPromise;
}

let phonModule = null;
export let lastPhon = null; // zur Fehlersuche
async function phonemizer() {
  if (!phonModule) phonModule = import(base + 'piper/phonemize.js');
  return (await phonModule).createPiperPhonemize;
}

// Text → Lautschrift. Eine Instanz von espeak-ng wird wiederverwendet (das Laden der
// Sprachdaten dauert, ein Aufruf nur Millisekunden); Aufrufe nacheinander, nicht gleichzeitig.
let phonInst = null, phonSink = null, phonQueue = Promise.resolve();
async function phonInstance() {
  if (!phonInst) {
    const create = await phonemizer();
    phonInst = create({
      print: (line) => { lastPhon = line; if (phonSink) phonSink(line); },
      printErr: (msg) => { if (/error/i.test(msg)) console.warn('espeak', msg); },
      locateFile: (f) => base + 'piper/' + (f.endsWith('.wasm') ? 'piper_phonemize.wasm' : f.endsWith('.data') ? 'piper_phonemize.data' : f),
    }).catch((e) => { phonInst = null; throw e; });
  }
  return phonInst;
}
function phonemeIds(text, voice) {
  const job = phonQueue.then(async () => {
    const m = await phonInstance();
    let line = null;
    phonSink = (l) => { if (line === null) line = l; };
    try {
      m.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    } finally { phonSink = null; }
    if (line === null) throw new Error('Keine Lautschrift erhalten');
    return JSON.parse(line);
  });
  phonQueue = job.catch(() => {});
  return job;
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
  if (loaded && loaded.id === id) loaded = null;
  try {
    const c = await caches.open(CACHE);
    await c.delete('/voices/' + id + '.onnx');
    await c.delete('/voices/' + id + '.onnx.json');
  } catch (e) { /* */ }
}

// ---------- Sprechen ----------

let loaded = null; // { id, session, cfg }
async function load(id) {
  if (loaded && loaded.id === id) return loaded;
  const ort = await loadOrt();
  const m = await cached(id, '.onnx'), j = await cached(id, '.onnx.json');
  if (!m || !j) throw new Error('Stimme ist nicht geladen');
  const cfg = await j.json();
  const session = await ort.InferenceSession.create(new Uint8Array(await m.arrayBuffer()), { executionProviders: ['wasm'] });
  loaded = { id, session, cfg, ort };
  return loaded;
}

// Lautschrift → Nummern nach der Tabelle des Modells (wie piper: ^ Laut _ Laut _ … $)
function idsFor(ph, cfg) {
  const map = cfg.phoneme_id_map;
  const phonemes = ph.phonemes || ph.phoneme_list;
  if (!map || !phonemes) return ph.phoneme_ids;
  const flat = Array.isArray(phonemes[0]) ? phonemes.flat() : [...(Array.isArray(phonemes) ? phonemes.join('') : phonemes)];
  const id = (c) => (map[c] ? map[c][0] : null);
  const out = [id('^') ?? 1];
  const pad = id('_') ?? 0;
  for (const c of flat) {
    const v = id(c);
    if (v == null) continue;
    out.push(v, pad);
  }
  out.push(id('$') ?? 2);
  return out;
}

// Text → { samples: Float32Array, rate }
// rate: Sprechtempo (1 = normal); längere Pausen nach Satzzeichen erzeugt das Modell selbst
export async function synthesize(id, text, { rate = 1 } = {}) {
  const { session, cfg, ort } = await load(id);
  const ph = await phonemeIds(text, (cfg.espeak && cfg.espeak.voice) || 'de');
  const ids = idsFor(ph, cfg);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / rate, inf.noise_w ?? 0.8]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  return { samples: out.output.data, rate: (cfg.audio && cfg.audio.sample_rate) || 22050 };
}

// Wiedergabe über die Web-Audio-API. Auf dem iPhone als „Wiedergabe“ anmelden, damit der
// Stummschalter nicht stumm schaltet (Safari 17+).
let ctx = null;
export function audioContext() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* */ }
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Spielt Samples ab → { stop(), done: Promise<boolean (true = zu Ende gespielt)>, duration }
export function play({ samples, rate }) {
  const ac = audioContext();
  const buf = ac.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  let finish;
  const done = new Promise((r) => { finish = r; });
  let stopped = false;
  src.onended = () => finish(!stopped);
  src.start();
  return { duration: buf.duration, started: ac.currentTime, stop() { stopped = true; try { src.stop(); } catch (e) { /* */ } finish(false); }, done };
}

export const supported = () => typeof WebAssembly === 'object' && 'caches' in window && !!(window.AudioContext || window.webkitAudioContext);
