// Gemeinsame Helfer für die Anmeldung per Weiterleitung (funktioniert auch in installierten Web-Apps auf iOS).

import config from '../config.js';

export class AuthError extends Error {
  constructor(msg = 'Anmeldung erforderlich') { super(msg); this.name = 'AuthError'; }
}
export class ConflictError extends Error {
  constructor() { super('Datei wurde zwischenzeitlich geändert'); this.name = 'ConflictError'; }
}

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function clientId(provider) {
  let v = '';
  try { v = localStorage.getItem('ob.cfg.' + provider) || ''; } catch (e) { /* ignorieren */ }
  return v.trim() || (provider === 'google' ? config.googleClientId : config.microsoftClientId) || '';
}

export function randomString(len = 43) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a).slice(0, len);
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

// Merkt sich den laufenden Anmeldevorgang über die Weiterleitung hinweg
export function savePending(data) {
  const v = JSON.stringify({ ...data, returnHash: location.hash || '#/', at: Date.now() });
  try { sessionStorage.setItem('ob.oauth', v); } catch (e) { /* ignorieren */ }
  try { localStorage.setItem('ob.oauth', v); } catch (e) { /* ignorieren */ }
}
export function takePending() {
  let v = null;
  try { v = sessionStorage.getItem('ob.oauth') || localStorage.getItem('ob.oauth'); } catch (e) { /* ignorieren */ }
  try { sessionStorage.removeItem('ob.oauth'); localStorage.removeItem('ob.oauth'); } catch (e) { /* ignorieren */ }
  if (!v) return null;
  try {
    const d = JSON.parse(v);
    if (Date.now() - d.at > 15 * 60 * 1000) return null;
    return d;
  } catch (e) { return null; }
}

export function loadToken(provider) {
  try { return JSON.parse(localStorage.getItem('ob.tok.' + provider) || 'null'); } catch (e) { return null; }
}
export function storeToken(provider, tok) {
  try {
    if (tok) localStorage.setItem('ob.tok.' + provider, JSON.stringify(tok));
    else localStorage.removeItem('ob.tok.' + provider);
  } catch (e) { /* ignorieren */ }
}

// Nach der Rückkehr: Adresse aufräumen und zur vorherigen Ansicht zurück
export function cleanUrl(returnHash) {
  history.replaceState(null, '', location.pathname + (returnHash || '#/'));
}
