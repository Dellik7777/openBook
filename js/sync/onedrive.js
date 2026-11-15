// OneDrive: Daten liegen im App-Ordner „Apps/<Name der App-Registrierung>“ des Nutzers.
// Anmeldung per OAuth 2.0 Authorization Code + PKCE (ohne Server). Das Erneuerungs-Token
// hält die Anmeldung aktiv, solange Lesepixel mindestens etwa einmal am Tag genutzt wird.

import { AuthError, ConflictError, redirectUri, clientId, randomString, pkceChallenge, savePending, loadToken, storeToken, cleanUrl } from './oauth.js';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const ROOT = GRAPH + '/me/drive/special/approot';
const SCOPE = 'Files.ReadWrite.AppFolder User.Read offline_access';

export const onedrive = {
  id: 'onedrive',
  label: 'OneDrive',

  isConfigured: () => !!clientId('microsoft'),

  account() { return (loadToken('onedrive') || {}).email || ''; },

  hasToken() {
    const t = loadToken('onedrive');
    return !!(t && (t.refresh_token || (t.access_token && t.exp > Date.now() + 60_000)));
  },

  async connect({ silent = false } = {}) {
    const state = randomString(24);
    const verifier = randomString(64);
    savePending({ provider: 'onedrive', state, verifier, silent });
    const t = loadToken('onedrive');
    const p = new URLSearchParams({
      client_id: clientId('microsoft'),
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: SCOPE,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    });
    if (silent) p.set('prompt', 'none');
    else p.set('prompt', 'select_account');
    if (t && t.email) p.set('login_hint', t.email);
    location.assign(`${AUTH}/authorize?${p}`);
  },

  async handleRedirect(pending) {
    const q = new URLSearchParams(location.search);
    if (q.get('state') !== pending.state) return { ok: false, error: 'Ungültige Antwort' };
    const code = q.get('code');
    const err = q.get('error');
    cleanUrl(pending.returnHash);
    if (err || !code) return { ok: false, error: q.get('error_description') || err || 'Abgebrochen', silent: pending.silent };
    const res = await fetch(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId('microsoft'),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        code_verifier: pending.verifier,
        scope: SCOPE,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error_description || 'Anmeldung fehlgeschlagen' };
    const tok = { access_token: json.access_token, refresh_token: json.refresh_token, exp: Date.now() + (json.expires_in || 3600) * 1000, email: '' };
    storeToken('onedrive', tok);
    try {
      const me = await fetch(`${GRAPH}/me`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (me.ok) { const m = await me.json(); tok.email = m.userPrincipalName || m.mail || ''; storeToken('onedrive', tok); }
    } catch (e) { /* optional */ }
    return { ok: true };
  },

  async ensureToken() {
    const t = loadToken('onedrive');
    if (t && t.access_token && t.exp > Date.now() + 60_000) return true;
    if (!t || !t.refresh_token) throw new AuthError('OneDrive-Anmeldung erforderlich');
    const res = await fetch(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId('microsoft'), grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: SCOPE }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) storeToken('onedrive', { email: t.email });
      throw new AuthError('OneDrive-Anmeldung abgelaufen');
    }
    storeToken('onedrive', { ...t, access_token: json.access_token, refresh_token: json.refresh_token || t.refresh_token, exp: Date.now() + (json.expires_in || 3600) * 1000 });
    return true;
  },

  disconnect() { storeToken('onedrive', null); },

  async begin() { await this.ensureToken(); },

  async read(name, as = 'text') {
    const res = await api(`${ROOT}:/${encodeURIComponent(name)}`, {}, true);
    if (res.status === 404) return null;
    const meta = await res.json();
    const url = meta['@microsoft.graph.downloadUrl'];
    const dl = url ? await fetch(url) : await api(`${ROOT}:/${encodeURIComponent(name)}:/content`);
    if (!dl.ok) throw new Error(`OneDrive: Lesen fehlgeschlagen (${dl.status})`);
    return { data: as === 'blob' ? await dl.blob() : await dl.text(), version: meta.eTag };
  },

  async remove(name) {
    await api(`${ROOT}:/${encodeURIComponent(name)}`, { method: 'DELETE' }, true);
  },

  // ifVersion: undefined = egal, null = Datei darf noch nicht existieren, sonst erwarteter eTag
  async write(name, data, type, { ifVersion } = {}) {
    const headers = { 'Content-Type': type };
    let url = `${ROOT}:/${encodeURIComponent(name)}:/content`;
    if (ifVersion === null) url += '?@microsoft.graph.conflictBehavior=fail';
    else if (ifVersion !== undefined) headers['If-Match'] = ifVersion;
    const res = await api(url, { method: 'PUT', headers, body: data }, false, true);
    if (res.status === 409 || res.status === 412) throw new ConflictError();
    return (await res.json()).eTag;
  },
};

async function api(url, opts = {}, allow404 = false, allowConflict = false) {
  await onedrive.ensureToken();
  const t = loadToken('onedrive');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t.access_token } });
  if (res.status === 401) { storeToken('onedrive', { ...t, exp: 0 }); throw new AuthError('OneDrive-Anmeldung abgelaufen'); }
  if (res.status === 404 && allow404) return res;
  if ((res.status === 409 || res.status === 412) && allowConflict) return res;
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error.message; } catch (e) { /* ignorieren */ }
    throw new Error(`OneDrive (${res.status}) ${msg}`.trim());
  }
  return res;
}
