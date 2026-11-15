// Lernkarten aus Markierungen (Karteikasten nach Leitner).
//
// Jede Markierung wird zu einer Karte:
//   - Notiz endet mit „?“ → Vorderseite = Frage (Notiz), Rückseite = markierte Stelle
//   - sonst Lückentext: ein wichtiges Wort der Stelle wird ausgeblendet
// Fach 1–5; „Wusste ich“ → ein Fach weiter, „Nochmal“ → zurück in Fach 1.
// Wiederholung nach 1, 2, 4, 8, 16 Tagen (danach 32).
// Lernstand je Profil: meta 'cards|<profileId>' = { cards: { '<bookId>:<hlId>': { box, due, at, off } } }

import * as db from './db.js';

const DAY = 86400000;
const INTERVAL = [0, 1, 2, 4, 8, 16, 32];
export const NEW_PER_SESSION = 20;

const STOP = new Set('aber alle allem allen aller alles als also andere anderen auch auf aus bei beim bin bis bist dann darum dass dein deine dem den denn der des dessen deshalb die dies diese diesem diesen dieser dieses doch dort durch eine einem einen einer eines einige etwas euch euer für gegen gewesen habe haben hatte hatten hier hinter ihre ihrem ihren ihrer immer indem jede jedem jeden jeder jedes jetzt kann kein keine können könnte machen mehr mein meine mich mit muss musste nach nicht nichts noch nun nur oder ohne schon sehr sein seine seinem seinen seiner selbst sich sie sind soll sollte sondern sonst über unter viel vielleicht vom von vor wann warum was weil welche welchem welchen welcher welches wenn werde werden wieder will wird wollen wurde wurden würde zwischen zum zur'.split(' '));

function hash(s) { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; }

// Wort für die Lücke: lang, kein Füllwort; Substantive (groß, nicht am Satzanfang) bevorzugt
export function clozeOf(text, seed = '') {
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]/gu)].map((m) => ({ w: m[0], i: m.index }));
  const cands = words.filter(({ w, i }) => w.length >= 5 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w)).map(({ w, i }) => {
    const before = text.slice(Math.max(0, i - 3), i);
    const sentenceStart = i === 0 || /[.!?:]\s*$/.test(before);
    const noun = /^\p{Lu}/u.test(w) && !sentenceStart;
    return { w, i, score: w.length + (noun ? 6 : 0) + (/\d/.test(w) ? 3 : 0) };
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const top = cands.filter((c) => c.score >= cands[0].score - 2);
  const pick = top[hash(seed) % top.length];
  return { word: pick.w, before: text.slice(0, pick.i), after: text.slice(pick.i + pick.w.length) };
}

export function cardOf(hl) {
  const text = (hl.text || '').replace(/\s+/g, ' ').trim();
  const note = (hl.note || '').trim();
  if (note.endsWith('?')) return { kind: 'question', question: note, answer: text };
  const c = clozeOf(text, hl.id);
  return c ? { kind: 'cloze', ...c, note } : { kind: 'recall', answer: text, note };
}

async function load(profileId) { return (await db.getMeta('cards|' + profileId)) || { cards: {} }; }
async function save(profileId, data) { await db.setMeta('cards|' + profileId, data); db.emit('cards', profileId); }

// Alle Karten des Profils (optional nur eines Buchs). canOpen(book) filtert gesperrte Bücher.
export async function collect(profileId, { bookId = null, canOpen = () => true } = {}) {
  const books = new Map((await db.getBooks()).map((b) => [b.id, b]));
  const data = await load(profileId);
  const out = [];
  for (const st of await db.getStatesOfProfile(profileId)) {
    if (bookId && st.bookId !== bookId) continue;
    const book = books.get(st.bookId);
    if (!book || !canOpen(book)) continue;
    for (const hl of st.highlights || []) {
      if (hl.deleted || !hl.text || hl.text.trim().length < 3) continue;
      const key = st.bookId + ':' + hl.id;
      const rec = data.cards[key] || null;
      if (rec && rec.off) continue;
      out.push({ key, book, hl, rec, card: cardOf(hl) });
    }
  }
  return out;
}

// Fällige Karten: wiederholte zuerst (älteste Fälligkeit), dann neue (max. NEW_PER_SESSION)
export function due(list, now = Date.now()) {
  const rep = list.filter((c) => c.rec && c.rec.due <= now).sort((a, b) => a.rec.due - b.rec.due);
  const fresh = list.filter((c) => !c.rec).sort((a, b) => (a.hl.createdAt || 0) - (b.hl.createdAt || 0)).slice(0, NEW_PER_SESSION);
  return [...rep, ...fresh];
}

export async function review(profileId, key, knew) {
  const data = await load(profileId);
  const cur = data.cards[key] || { box: 0 };
  const box = knew ? Math.min(6, (cur.box || 0) + 1) : 1;
  const now = Date.now();
  // „Nochmal“: in 10 Minuten wieder fällig (in der laufenden Runde kommt sie ans Ende)
  const dueAt = knew ? startOfDay(now) + INTERVAL[box] * DAY : now + 10 * 60000;
  data.cards[key] = { box, due: dueAt, at: now };
  await save(profileId, data);
  return data.cards[key];
}

export async function suspend(profileId, key) {
  const data = await load(profileId);
  data.cards[key] = { ...(data.cards[key] || { box: 0, due: 0 }), off: true, at: Date.now() };
  await save(profileId, data);
}

export async function summary(profileId, opts) {
  const list = await collect(profileId, opts);
  const now = Date.now();
  const learned = list.filter((c) => c.rec && c.rec.box >= 4).length;
  return { total: list.length, due: due(list, now).length, learned, list };
}

function startOfDay(t) { const d = new Date(t); d.setHours(4, 0, 0, 0); return d.getTime() > t ? d.getTime() - DAY : d.getTime(); }

// Lernstand von anderen Geräten zusammenführen (jüngste Änderung je Karte gewinnt)
export function mergeCards(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) if (!out[k] || (v.at || 0) > (out[k].at || 0)) out[k] = v;
  return out;
}
export const cardsKey = (profileId) => 'cards|' + profileId;
