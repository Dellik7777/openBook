// App-Sperre mit Face ID / Touch ID (WebAuthn, Plattform-Authentifizierung) und PIN als Ersatz.
//
// Wichtig: Das ist ein Sichtschutz, keine Verschlüsselung. Wer das entsperrte Gerät hat und
// Entwicklerwerkzeuge bedienen kann, könnte die Daten im Browser-Speicher trotzdem lesen.

import { h, icon, pixels } from './ui.js';

const KEY = 'ob.lock';
let unlockedAt = 0;      // Zeitpunkt der letzten Entsperrung in dieser Sitzung
let hiddenAt = 0;
let overlay = null;
let pending = null;

function cfg() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
}
function saveCfg(c) {
  try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else localStorage.removeItem(KEY); } catch (e) { /* */ }
}

export const isEnabled = () => !!(cfg() && cfg().enabled);
export const isConfigured = () => !!(cfg() && (cfg().credId || cfg().pinHash));
export const hasBiometrics = () => !!(cfg() && cfg().credId);
export const settings = () => cfg() || {};
export const isUnlocked = () => !!unlockedAt;

export async function biometricsAvailable() {
  try {
    return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { return false; }
}

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ':' + pin);
  let buf = await crypto.subtle.digest('SHA-256', data);
  for (let i = 0; i < 2000; i++) buf = await crypto.subtle.digest('SHA-256', buf);
  return b64(buf);
}

// Einrichten: optional Face ID registrieren, PIN ist Pflicht (Ersatz, falls Face ID nicht geht)
export async function setup({ pin, biometrics, delay = 1 }) {
  const c = { enabled: true, delay };
  c.salt = b64(rand(16));
  c.pinHash = await hashPin(pin, c.salt);
  if (biometrics) {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: 'Lesepixel' },
        user: { id: rand(16), name: 'lesepixel', displayName: 'Lesepixel' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    c.credId = b64(cred.rawId);
  }
  saveCfg(c);
  unlockedAt = Date.now();
}

export function disable() { saveCfg(null); unlockedAt = Date.now(); }
export function setDelay(min) { const c = cfg(); if (c) { c.delay = min; saveCfg(c); } }

async function verifyBiometric() {
  const c = cfg();
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: unb64(c.credId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  // Flags im authenticatorData: Bit 2 = Nutzer verifiziert (Face ID / Touch ID / Gerätecode)
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  return !!(flags & 0x04);
}

async function verifyPin(pin) {
  const c = cfg();
  return (await hashPin(pin, c.salt)) === c.pinHash;
}

// Sperrbildschirm anzeigen und auf Entsperren warten
export function lockNow(reason = '') {
  if (!isEnabled() && !reason) return Promise.resolve(true);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const pinInput = h('input', { class: 'input lock-pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'PIN' });
    const msg = h('p', { class: 'lock-msg' });
    const done = () => {
      unlockedAt = Date.now();
      overlay.remove(); overlay = null; pending = null;
      document.documentElement.classList.remove('locked');
      resolve(true);
    };
    const cancel = () => { overlay.remove(); overlay = null; pending = null; resolve(false); };
    const tryBio = async () => {
      msg.textContent = '';
      try { if (await verifyBiometric()) return done(); msg.textContent = 'Nicht erkannt.'; } catch (e) { msg.textContent = 'Face ID nicht verfügbar – bitte PIN eingeben.'; }
    };
    const tryPin = async (e) => {
      e && e.preventDefault();
      if (await verifyPin(pinInput.value)) return done();
      msg.textContent = 'Falsche PIN.';
      pinInput.value = '';
      pinInput.focus();
    };
    overlay = h('div', { class: 'lockscreen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Gesperrt' },
      h('div', { class: 'lock-box' },
        pixels(),
        h('h2', {}, reason ? 'Gesperrtes Buch' : 'Lesepixel ist gesperrt'),
        reason ? h('p', { class: 'lock-sub' }, reason) : null,
        hasBiometrics() ? h('button', { class: 'btn primary block', onClick: tryBio }, icon('lock'), 'Mit Face ID / Touch ID entsperren') : null,
        h('form', { class: 'lock-form', onSubmit: tryPin }, pinInput, h('button', { class: 'btn block', type: 'submit' }, 'Mit PIN entsperren')),
        msg,
        reason ? h('button', { class: 'linkish lock-cancel', onClick: cancel }, 'Abbrechen') : null,
      ),
    );
    if (!reason) document.documentElement.classList.add('locked');
    document.body.append(overlay);
    if (hasBiometrics()) setTimeout(tryBio, 300); else setTimeout(() => pinInput.focus(), 200);
  });
  return pending;
}

// Für gesperrte Bücher: in dieser Sitzung schon entsperrt? Sonst nachfragen.
export async function ensureBookAccess(book) {
  if (!book || !book.locked) return true;
  if (!isConfigured()) return true; // ohne eingerichtete Sperre nicht blockieren
  if (unlockedAt && Date.now() - unlockedAt < 10 * 60_000) return true;
  return lockNow(`„${book.title}“ ist gesperrt.`);
}

// Beim Start und nach Rückkehr aus dem Hintergrund sperren
export function init() {
  if (isEnabled()) lockNow();
  document.addEventListener('visibilitychange', () => {
    if (!isEnabled()) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const delay = (cfg().delay ?? 1) * 60_000;
    if (hiddenAt && Date.now() - hiddenAt >= delay) lockNow();
  });
}
