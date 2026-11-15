// Lesestatistik je Profil: Lesezeit und umgeblätterte Seiten pro Tag.
// Wird nur auf diesem Gerät gespeichert.

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

export async function getStats(profileId) {
  const st = await load(profileId);
  return JSON.parse(JSON.stringify(st));
}
