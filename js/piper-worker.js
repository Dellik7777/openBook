// Web Worker für die eigenen Stimmen: Lautschrift (eSpeak NG) und Sprachmodell (ONNX Runtime)
// laufen hier, damit die Oberfläche während der Berechnung bedienbar bleibt.
//
// Nachrichten:  { id, type: 'synth', voice, text, rate }  →  { id, samples, rate } | { id, error }
//               { id, type: 'drop', voice }               →  { id } (Modell aus dem Speicher werfen)

import * as ort from '../vendor/ort/ort.wasm.esm.min.js';
import { createPiperPhonemize } from '../vendor/piper/phonemize.js';

const vendor = new URL('../vendor/', import.meta.url).href;
const CACHE = 'ob-voices-v1';
ort.env.wasm.wasmPaths = vendor + 'ort/';
ort.env.wasm.numThreads = 1; // ohne Cross-Origin-Isolation gibt es keine Threads
ort.env.wasm.simd = true;

// eSpeak NG einmal laden und wiederverwenden
let phon = null, sink = null;
function phonInstance() {
  if (!phon) {
    phon = createPiperPhonemize({
      print: (line) => { if (sink) sink(line); },
      printErr: (msg) => { if (/error/i.test(msg)) console.warn('espeak', msg); },
      locateFile: (f) => vendor + 'piper/' + (f.endsWith('.wasm') ? 'piper_phonemize.wasm' : f.endsWith('.data') ? 'piper_phonemize.data' : f),
    }).catch((e) => { phon = null; throw e; });
  }
  return phon;
}
async function phonemize(text, lang) {
  const m = await phonInstance();
  let line = null;
  sink = (l) => { if (line === null) line = l; };
  try { m.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']); } finally { sink = null; }
  if (line === null) throw new Error('Keine Lautschrift erhalten');
  return JSON.parse(line);
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

let loaded = null; // { voice, session, cfg }
async function load(voice) {
  if (loaded && loaded.voice === voice) return loaded;
  if (loaded) { try { await loaded.session.release(); } catch (e) { /* */ } loaded = null; }
  const c = await caches.open(CACHE);
  const m = await c.match('/voices/' + voice + '.onnx'), j = await c.match('/voices/' + voice + '.onnx.json');
  if (!m || !j) throw new Error('Stimme ist nicht geladen');
  const cfg = await j.json();
  const session = await ort.InferenceSession.create(new Uint8Array(await m.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  loaded = { voice, session, cfg };
  return loaded;
}

async function synth(voice, text, rate) {
  const { session, cfg } = await load(voice);
  const ph = await phonemize(text, (cfg.espeak && cfg.espeak.voice) || 'de');
  const ids = idsFor(ph, cfg);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (rate || 1), inf.noise_w ?? 0.8]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  return { samples: Float32Array.from(out.output.data), rate: (cfg.audio && cfg.audio.sample_rate) || 22050 };
}

// Aufträge nacheinander abarbeiten
let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'synth') {
        const r = await synth(msg.voice, msg.text, msg.rate);
        self.postMessage({ id: msg.id, samples: r.samples, rate: r.rate }, [r.samples.buffer]);
      } else if (msg.type === 'drop') {
        if (loaded && (!msg.voice || loaded.voice === msg.voice)) { try { await loaded.session.release(); } catch (err) { /* */ } loaded = null; }
        self.postMessage({ id: msg.id });
      }
    } catch (err) {
      self.postMessage({ id: msg.id, error: String(err && err.message || err) });
    }
  });
};
