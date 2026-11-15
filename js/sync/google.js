// Google Drive: Daten liegen im versteckten App-Ordner („appDataFolder“) des Nutzers.
// Anmeldung per OAuth-Weiterleitung (Token-Flow); ein Zugriffstoken gilt ca. 1 Stunde
// und wird danach per kurzer, stiller Weiterleitung erneuert.

import { AuthError, ConflictError, redirectUri, clientId, randomString, savePending, loadToken, storeToken, cleanUrl } from './oauth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';

let files = null; // name → { id, version }

export const google = {
  id: 'google',
  label: 'Google Drive',

  isConfigured: () => !!clientId('google'),

  account() { return (loadToken('google') || {}).email || ''; },

  hasToken() {
    const t = loadToken('google');
    return !!(t && t.access_token && t.exp > Date.now() + 60_000);
  },

  connect({ silent = false } = {}) {
    const state = randomString(24);
    savePending({ provider: 'google', state, silent });
    const t = loadToken('google');
    const p = new URLSearchParams({
      client_id: clientId('google'),
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    if (silent) p.set('prompt', 'none');
    if (t && t.email) p.set('login_hint', t.email);
    location.assign(AUTH_URL + '?' + p.toString());
  },

  // Wird beim App-Start aufgerufen, wenn wir von Google zurückkommen
  async handleRedirect(pending) {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (params.get('state') !== pending.state) return { ok: false, error: 'Ungültige Antwort' };
    cleanUrl(pending.returnHash);
    if (params.get('error')) return { ok: false, error: params.get('error'), silent: pending.silent };
    const tok = {
      access_token: params.get('access_token'),
      exp: Date.now() + (parseInt(params.get('expires_in') || '3600', 10) * 1000),
      email: (loadToken('google') || {}).email || '',
    };
    storeToken('google', tok);
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (r.ok) { tok.email = (await r.json()).email || ''; storeToken('google', tok); }
    } catch (e) { /* optional */ }
    return { ok: true };
  },

  async ensureToken() {
    if (this.hasToken()) return true;
    throw new AuthError('Google-Anmeldung abgelaufen');
  },

  disconnect() {
    const t = loadToken('google');
    if (t && t.access_token) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.access_token), { method: 'POST' }).catch(() => {});
    }
    storeToken('google', null);
    files = null;
  },

  // ---------- Dateien ----------

  async begin() {
    files = new Map();
    let pageToken = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,version,modifiedTime)', pageSize: '1000', orderBy: 'modifiedTime' });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await api(`${API}/files?${q}`);
      const json = await res.json();
      // Bei doppelten Namen gewinnt die zuletzt geänderte Datei (sortiert nach modifiedTime)
      for (const f of json.files || []) files.set(f.name, { id: f.id, version: String(f.version) });
      pageToken = json.nextPageToken || '';
    } while (pageToken);
  },

  async read(name, as = 'text') {
    if (!files) await this.begin();
    const f = files.get(name);
    if (!f) return null;
    const res = await api(`${API}/files/${f.id}?alt=media`, {}, true);
    if (res.status === 404) { files.delete(name); return null; }
    if (!res.ok) throw new Error(`Google Drive: Lesen fehlgeschlagen (${res.status})`);
    return { data: as === 'blob' ? await res.blob() : await res.text(), version: f.version };
  },

  async remove(name) {
    if (!files) await this.begin();
    const f = files.get(name);
    if (!f) return;
    await api(`${API}/files/${f.id}`, { method: 'DELETE' }, true);
    files.delete(name);
  },

  // ifVersion: undefined = egal, null = Datei darf noch nicht existieren, sonst erwartete Version
  async write(name, data, type, { ifVersion } = {}) {
    if (!files) await this.begin();
    const body = data instanceof Blob ? data : new Blob([data], { type });
    let f = files.get(name);
    if (ifVersion !== undefined) {
      if (f) {
        const res = await api(`${API}/files/${f.id}?fields=version`);
        const cur = String((await res.json()).version);
        if (ifVersion === null || cur !== ifVersion) throw new ConflictError();
      } else if (ifVersion !== null) {
        throw new ConflictError();
      } else {
        const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${name}'`, fields: 'files(id)' });
        const res = await api(`${API}/files?${q}`);
        if (((await res.json()).files || []).length) throw new ConflictError();
      }
    }
    let res;
    if (f) {
      res = await api(`${UPLOAD}/files/${f.id}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
    } else {
      const boundary = 'ob' + randomString(16);
      const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
      const multipart = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, body, `\r\n--${boundary}--`,
      ]);
      res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      });
    }
    const json = await res.json();
    f = { id: json.id, version: String(json.version) };
    files.set(name, f);
    return f.version;
  },
};

async function api(url, opts = {}, allow404 = false) {
  const t = loadToken('google');
  if (!t || !t.access_token) throw new AuthError();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t.access_token } });
  if (res.status === 401) { storeToken('google', { ...t, exp: 0 }); throw new AuthError('Google-Anmeldung abgelaufen'); }
  if (res.status === 404 && allow404) return res;
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error.message; } catch (e) { /* ignorieren */ }
    throw new Error(`Google Drive (${res.status}) ${msg}`.trim());
  }
  return res;
}
