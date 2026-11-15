// Lesestatistik je Profil: Lesezeit und umgeblätterte Seiten pro Tag.
// Jedes Gerät zählt für sich (meta 'stats|<profil>'); mit Synchronisierung kommen die Zahlen
// der anderen Geräte dazu (meta 'statsRemote|<profil>' = { <geräte-id>: { days } }).

import * as db from './db.js';

const cache = new Map(); // profileId → { days: { 'JJJJ-MM-TT': { sec, turns, books: { bookId: sec } } } }
const timers = new Map();

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function load(profileId) {
  if (!cache.has(profileId)) cache.set(profileId, (await db.getMeta('stats|' + profileId)) || { days: {} });
  return cache.get(profileId);
}

function save(profileId) {
  clearTimeout(timers.get(profileId));
  timers.set(profileId, setTimeout(() => db.setMeta('stats|' + profileId, cache.get(profileId)), 1500));
}

function today(st) {
  const k = dayKey();
  if (!st.days[k]) st.days[k] = { sec: 0, turns: 0, books: {} };
  return st.days[k];
}

export async function addReading(profileId, bookId, sec) {
  const st = await load(profileId);
  const d = today(st);
  d.sec += sec;
  d.books[bookId] = (d.books[bookId] || 0) + sec;
  save(profileId);
}

export async function addTurn(profileId) {
  const st = await load(profileId);
  today(st).turns += 1;
  save(profileId);
}

// Eigene Zahlen dieses Geräts (für den Sync)
export async function ownStats(profileId) {
  const st = await load(profileId);
  return JSON.parse(JSON.stringify(st.days || {}));
}

// Zahlen aller Geräte zusammengezählt
export async function getStats(profileId) {
  const st = JSON.parse(JSON.stringify(await load(profileId)));
  const remote = (await db.getMeta('statsRemote|' + profileId)) || {};
  for (const dev of Object.values(remote)) {
    for (const [k, d] of Object.entries((dev && dev.days) || {})) {
      const t = st.days[k] || (st.days[k] = { sec: 0, turns: 0, books: {} });
      t.sec += d.sec || 0;
      t.turns += d.turns || 0;
      for (const [b, sec] of Object.entries(d.books || {})) t.books[b] = (t.books[b] || 0) + sec;
    }
  }
  st.devices = 1 + Object.keys(remote).length;
  return st;
}

export function deviceId() {
  let id = null;
  try { id = localStorage.getItem('ob.deviceId'); } catch (e) { /* */ }
  if (!id) {
    id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('ob.deviceId', id); } catch (e) { /* */ }
  }
  return id;
}
