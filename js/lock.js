// App-Sperre mit Face ID / Touch ID (WebAuthn, Plattform-Authentifizierung) und PIN als Ersatz.
//
// Die Sperre der ganzen App ist ein Sichtschutz. Gesperrte Bücher werden zusätzlich verschlüsselt
// gespeichert (vault.js): Den Schlüssel öffnet die PIN – und Face ID, wenn das Gerät die
// WebAuthn-Erweiterung PRF unterstützt.

import { h, icon, pixels, toast } from './ui.js';
import * as vault from './vault.js';
import * as db from './db.js';

const KEY = 'ob.lock';
let unlockedAt = 0;      // Zeitpunkt der letzten Entsperrung in dieser Sitzung
let hiddenAt = 0;
let overlay = null;
let pending = null;
let pendingPrf = null; // Face-ID-Schlüsselmaterial, das nach der nächsten PIN-Eingabe hinterlegt wird

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

const prfResult = (cred) => {
  try {
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    return { enabled: !!(ext.prf && (ext.prf.enabled || ext.prf.results)), first: ext.prf && ext.prf.results ? ext.prf.results.first : null };
  } catch (e) { return { enabled: false, first: null }; }
};

// Einrichten: optional Face ID registrieren, PIN ist Pflicht (Ersatz, falls Face ID nicht geht).
// Legt den Tresor für gesperrte Bücher an.
export async function setup({ pin, biometrics, delay = 1 }) {
  const c = { enabled: true, delay };
  c.salt = b64(rand(16));
  c.pinHash = await hashPin(pin, c.salt);
  if (vault.isSetup() && !(await db.getBooks()).some((b) => b.enc)) vault.destroy();
  if (!vault.isSetup()) await vault.create(pin);
  if (biometrics) {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: 'Lesepixel' },
        user: { id: rand(16), name: 'lesepixel', displayName: 'Lesepixel' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none',
        extensions: { prf: { eval: { first: vault.prfSalt() } } },
      },
    });
    c.credId = b64(cred.rawId);
    saveCfg(c);
    // Face ID als Schlüssel für den Tresor (PRF), falls das Gerät es kann
    let { enabled, first } = prfResult(cred);
    if (enabled && !first) {
      try { const r = await assert(); first = r.prf; } catch (e) { /* dann nur PIN für den Tresor */ }
    }
    if (first) await vault.addPrf(pin, first);
  }
  saveCfg(c);
  unlockedAt = Date.now();
}

// Ausschalten: verschlüsselte Bücher werden vorher entschlüsselt (Tresor muss offen sein)
export async function disable() {
  const enc = (await db.getBooks()).filter((b) => b.enc);
  if (enc.length) {
    if (!vault.isOpen() && !(await unlockVault('Zum Ausschalten bitte mit PIN bestätigen – gesperrte Bücher werden dabei entschlüsselt.'))) return false;
    for (const b of enc) await db.setBookEncrypted(b.id, false);
  }
  vault.destroy();
  saveCfg(null);
  unlockedAt = Date.now();
  return true;
}

export const vaultReady = () => vault.isSetup();
export const vaultOpen = () => vault.isOpen();
export const faceIdOpensVault = () => vault.hasPrf();

// Tresor öffnen (z. B. vor dem Sichern oder Verschlüsseln). Ohne Tresor: true.
export async function unlockVault(reason = 'Bitte entsperren.') {
  if (!isConfigured()) return true;
  if (vault.isOpen()) return true;
  return lockNow(reason, { needVault: true });
}

// Gesperrte Bücher verschlüsseln, entsperrte entschlüsseln (läuft, sobald der Tresor offen ist)
let reconciling = null;
export function reconcile() {
  if (!vault.isOpen() || !vault.isSetup()) return Promise.resolve();
  if (reconciling) return reconciling;
  reconciling = (async () => {
    try {
      for (const b of await db.getBooks()) {
        const want = !!b.locked;
        if (want === !!b.enc) continue;
        const n = b.pageOrder.length;
        if (n > 30) toast(want ? `„${b.title}“ wird verschlüsselt …` : `„${b.title}“ wird entschlüsselt …`, 4000);
        await db.setBookEncrypted(b.id, want);
      }
    } catch (e) { console.warn('Verschlüsselung', e); } finally { reconciling = null; }
  })();
  return reconciling;
}
export function setDelay(min) { const c = cfg(); if (c) { c.delay = min; saveCfg(c); } }

async function assert(signal) {
  const c = cfg();
  const salt = vault.prfSalt();
  const assertion = await navigator.credentials.get({
    ...(signal ? { signal } : {}),
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: unb64(c.credId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
      ...(salt ? { extensions: { prf: { eval: { first: salt } } } } : {}),
    },
  });
  // Flags im authenticatorData: Bit 2 = Nutzer verifiziert (Face ID / Touch ID / Gerätecode)
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  return { ok: !!(flags & 0x04), prf: prfResult(assertion).first };
}

async function verifyBiometric(signal) {
  const r = await assert(signal);
  if (!r.ok) return false;
  if (r.prf && vault.isSetup()) {
    if (vault.hasPrf()) await vault.openWithPrf(r.prf);
    else pendingPrf = r.prf; // wird mit der nächsten PIN hinterlegt
  }
  return true;
}

async function verifyPin(pin) {
  const c = cfg();
  if ((await hashPin(pin, c.salt)) !== c.pinHash) return false;
  // Tresor öffnen – oder anlegen, falls die Sperre aus einer älteren Version stammt
  if (vault.isSetup()) await vault.openWithPin(pin);
  else await vault.create(pin);
  if (pendingPrf && !vault.hasPrf()) { await vault.addPrf(pin, pendingPrf); pendingPrf = null; }
  return true;
}

// Sperrbildschirm anzeigen und auf Entsperren warten
// needVault: erst fertig, wenn auch der Tresor offen ist (bei Face ID ohne PRF zusätzlich PIN)
export function lockNow(reason = '', { needVault = false } = {}) {
  if (!isEnabled() && !reason) return Promise.resolve(true);
  if (pending) return pending;
  if (!reason) vault.close(); // ganze App gesperrt → Schlüssel verwerfen
  pending = new Promise((resolve) => {
    const pinInput = h('input', { class: 'input lock-pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'PIN' });
    const msg = h('p', { class: 'lock-msg' });
    const done = () => {
      if (!overlay) return; // schon entsperrt (z. B. zwei Face-ID-Antworten)
      if (needVault && vault.isSetup() && !vault.isOpen()) {
        msg.textContent = 'Für verschlüsselte Bücher bitte zusätzlich die PIN eingeben.';
        pinInput.focus();
        return;
      }
      unlockedAt = Date.now();
      overlay.remove(); overlay = null; pending = null;
      document.documentElement.classList.remove('locked');
      resolve(true);
    };
    const cancel = () => { overlay.remove(); overlay = null; pending = null; resolve(false); };
    // Erneutes Antippen bricht eine noch offene Face-ID-Abfrage ab und startet neu
    let bioCtl = null;
    const tryBio = async () => {
      msg.textContent = '';
      const replaced = !!bioCtl;
      if (bioCtl) bioCtl.abort();
      const ctl = bioCtl = new AbortController();
      const t0 = Date.now();
      try {
        // Nach dem Abbrechen einer offenen Abfrage lehnt der Browser die nächste manchmal sofort ab → einmal wiederholen
        let ok;
        try { ok = await verifyBiometric(ctl.signal); } catch (e) {
          if (!replaced || ctl.signal.aborted || Date.now() - t0 > 1500) throw e;
          await new Promise((r) => setTimeout(r, 400));
          ok = await verifyBiometric(ctl.signal);
        }
        if (ok) return done();
        msg.textContent = 'Nicht erkannt.';
      } catch (e) {
        if (ctl.signal.aborted) return;
        console.warn('Face ID', e && e.name, e && e.message);
        msg.textContent = 'Face ID nicht verfügbar – bitte PIN eingeben.';
      } finally { if (bioCtl === ctl) bioCtl = null; }
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
        hasBiometrics() && !(needVault && vault.isSetup() && !vault.hasPrf()) ? h('button', { class: 'btn primary block', onClick: tryBio }, icon('lock'), 'Mit Face ID / Touch ID entsperren') : null,
        h('form', { class: 'lock-form', onSubmit: tryPin }, pinInput, h('button', { class: 'btn block', type: 'submit' }, 'Mit PIN entsperren')),
        msg,
        reason ? h('button', { class: 'linkish lock-cancel', onClick: cancel }, 'Abbrechen') : null,
      ),
    );
    if (!reason) document.documentElement.classList.add('locked');
    document.body.append(overlay);
    if (hasBiometrics() && !(needVault && vault.isSetup() && !vault.hasPrf())) setTimeout(tryBio, 300); else setTimeout(() => pinInput.focus(), 200);
  });
  return pending;
}

// Für gesperrte Bücher: in dieser Sitzung schon entsperrt? Sonst nachfragen.
export async function ensureBookAccess(book) {
  if (!book) return true;
  // Verschlüsselt: ohne offenen Tresor gibt es nichts zu lesen
  if (book.enc && vault.isSetup()) {
    if (vault.isOpen()) return true;
    return lockNow(`„${book.title}“ ist gesperrt und verschlüsselt.`, { needVault: true });
  }
  if (!book.locked) return true;
  if (!isConfigured()) return true; // ohne eingerichtete Sperre nicht blockieren
  if (unlockedAt && Date.now() - unlockedAt < 10 * 60_000) return true;
  return lockNow(`„${book.title}“ ist gesperrt.`, { needVault: vault.isSetup() });
}

// Beim Start und nach Rückkehr aus dem Hintergrund sperren
export function init() {
  if (isEnabled()) lockNow();
  document.addEventListener('visibilitychange', () => {
    if (!isConfigured()) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const delay = (cfg().delay ?? 1) * 60_000;
    if (hiddenAt && Date.now() - hiddenAt >= delay) {
      vault.close(); // Schlüssel nach längerer Abwesenheit verwerfen
      unlockedAt = 0;
      if (isEnabled()) lockNow();
    }
  });
}
