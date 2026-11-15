// Tresor für gesperrte Bücher: Ein zufälliger AES-256-GCM-Schlüssel verschlüsselt Texte, Fotos,
// Abbildungen, Markierungen und Lesezeichen gesperrter Bücher im Speicher des Geräts.
//
// Der Schlüssel selbst wird nur „verpackt“ gespeichert:
//   - mit der PIN (PBKDF2-SHA-256, 310 000 Runden)
//   - mit Face ID / Touch ID, wenn das Gerät die WebAuthn-Erweiterung „PRF“ kann
//     (Safari ab iOS 18, Chrome/Android mit Passkeys). Sonst wird für den Tresor die PIN gebraucht.
// Entsperrt liegt er nur im Arbeitsspeicher und wird beim Sperren verworfen.

const CFG = 'ob.vault';
const ITER = 310000;
let key = null;
const listeners = new Set();

export class LockedError extends Error {
  constructor() { super('Gesperrtes Buch – bitte zuerst entsperren'); this.name = 'LockedError'; }
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const enc = new TextEncoder(), dec = new TextDecoder();

function cfg() { try { return JSON.parse(localStorage.getItem(CFG) || 'null'); } catch (e) { return null; } }
function saveCfg(c) { try { if (c) localStorage.setItem(CFG, JSON.stringify(c)); else localStorage.removeItem(CFG); } catch (e) { /* */ } }

export const isSetup = () => !!cfg();
export const isOpen = () => !!key;
export const hasPrf = () => !!(cfg() && cfg().prf);
export const prfSalt = () => { const c = cfg(); return c && c.prfSalt ? unb64(c.prfSalt) : null; };
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) try { fn(isOpen()); } catch (e) { console.error(e); } }

async function pinKek(pin, salt, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function prfKek(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lesepixel-tresor'), info: enc.encode('kek-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function wrap(kek, raw) {
  const iv = rand(12);
  return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw)) };
}
async function unwrap(kek, w) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, kek, unb64(w.ct));
}
async function useRaw(raw) {
  key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  new Uint8Array(raw).fill(0);
  emit();
}

// Neuer Tresor (beim Einrichten der Sperre). prf: optional Ausgabe der Face-ID-PRF-Erweiterung
export async function create(pin, prf = null) {
  const raw = rand(32);
  const salt = rand(16);
  const c = { v: 1, salt: b64(salt), iter: ITER, prfSalt: b64(rand(32)) };
  c.pin = await wrap(await pinKek(pin, salt), raw);
  if (prf) c.prf = await wrap(await prfKek(prf), raw);
  saveCfg(c);
  await useRaw(raw.buffer);
}

export async function openWithPin(pin) {
  const c = cfg();
  if (!c) return false;
  try { await useRaw(await unwrap(await pinKek(pin, unb64(c.salt), c.iter || ITER), c.pin)); return true; } catch (e) { return false; }
}

export async function openWithPrf(prf) {
  const c = cfg();
  if (!c || !c.prf || !prf) return false;
  try { await useRaw(await unwrap(await prfKek(prf), c.prf)); return true; } catch (e) { return false; }
}

// Face ID nachträglich hinzufügen (Tresor muss offen sein) – braucht den Rohschlüssel,
// daher wird er beim Öffnen per PIN kurz entpackt.
export async function addPrf(pin, prf) {
  const c = cfg();
  if (!c || !prf) return false;
  try {
    const raw = await unwrap(await pinKek(pin, unb64(c.salt), c.iter || ITER), c.pin);
    c.prf = await wrap(await prfKek(prf), raw);
    new Uint8Array(raw).fill(0);
    saveCfg(c);
    return true;
  } catch (e) { return false; }
}

export function close() { if (key) { key = null; emit(); } }
export function destroy() { key = null; saveCfg(null); emit(); }

// ---------- Ver- und Entschlüsseln ----------

function need() { if (!key) throw new LockedError(); return key; }

export async function sealBytes(data) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, need(), data);
  return { iv, ct };
}
export async function openBytes(s) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, need(), s.ct instanceof Blob ? await s.ct.arrayBuffer() : s.ct);
}
export async function sealJson(obj) { return sealBytes(enc.encode(JSON.stringify(obj))); }
export async function openJson(s) { return JSON.parse(dec.decode(await openBytes(s))); }
// Bilder: Chiffrat als Blob (bleibt auf der Platte, belegt keinen Arbeitsspeicher)
export async function sealBlob(blob) {
  const s = await sealBytes(await blob.arrayBuffer());
  return { iv: s.iv, ct: new Blob([s.ct]), type: blob.type || 'image/jpeg' };
}
export async function openBlob(s) { return new Blob([await openBytes(s)], { type: s.type || 'image/jpeg' }); }
