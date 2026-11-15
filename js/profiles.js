// Leseprofile: Jede Person hat eigene Leseposition, Lesezeichen und Leseeinstellungen.
// Welches Profil auf diesem Gerät aktiv ist, merkt sich das Gerät selbst.

import * as db from './db.js';

let active = null;
const listeners = new Set();

export async function ensureProfile() {
  const profiles = await db.getProfiles();
  let id = null;
  try { id = localStorage.getItem('ob.profile'); } catch (e) { /* ignorieren */ }
  active = profiles.find((p) => p.id === id) || null;
  if (!active) {
    active = profiles.sort((a, b) => a.createdAt - b.createdAt)[0] || null;
    if (!active) {
      let settings = {};
      try { settings = JSON.parse(localStorage.getItem('ob.reader') || '{}'); } catch (e) { /* ignorieren */ }
      active = await db.createProfile('Ich', db.PROFILE_COLORS[0]);
      if (Object.keys(settings).length) { active.settings = settings; await db.putProfile(active); }
    }
    remember(active.id);
  }
  return active;
}

function remember(id) {
  try { localStorage.setItem('ob.profile', id); } catch (e) { /* ignorieren */ }
}

export function current() { return active; }
export function currentId() { return active && active.id; }

export async function switchTo(id) {
  const p = await db.getProfile(id);
  if (!p) return;
  active = p;
  remember(id);
  for (const fn of listeners) try { fn(active); } catch (e) { console.error(e); }
}

export function onSwitch(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Profil wurde (z. B. per Sync) geändert oder gelöscht → neu laden
db.onChange(async (e) => {
  if (e.type !== 'profile' || !active || e.id !== active.id) return;
  const p = await db.getProfile(active.id);
  if (p) { active = p; return; }
  await ensureProfile();
  for (const fn of listeners) try { fn(active); } catch (err) { console.error(err); }
});

export function getSettings() {
  return { ...((active && active.settings) || {}) };
}

let saveTimer = null;
export function saveSettings(settings) {
  if (!active) return;
  active.settings = { ...settings };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.putProfile(active), 500);
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
