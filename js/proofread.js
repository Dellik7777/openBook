// Textprüfung für ein ganzes Buch: findet wahrscheinliche Lesefehler der Texterkennung.
//
// Ein Buch verrät viel über sich selbst: Steht „Lindqvist“ fünfmal im Buch und einmal
// „Lindqyist“, ist der Ausreißer fast sicher ein Lesefehler. Dazu kommt eine deutsche
// Wortliste (Tesseract, Apache-2.0), um Unwörter wie „Ste“ (statt „Sie“) zu erkennen.
//
//  - eindeutige Fälle (typische Verwechslung, sicherer Ersatz) werden automatisch korrigiert
//  - zweifelhafte Stellen kommen in eine Prüfliste
//  - unbekannte Wörter ohne ähnlichen Kandidaten (Namen, lange Zusammensetzungen) bleiben unangetastet

import { stripMd } from './rich.js';

let wordsPromise = null;
// → Map(kleingeschrieben → Rang (0 = häufigstes Wort))
export function loadWordlist() {
  if (!wordsPromise) {
    wordsPromise = fetch(new URL('../vendor/wordlist/deu.txt', import.meta.url))
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        const m = new Map();
        t.split('\n').forEach((w, i) => { if (w) m.set(w.toLowerCase(), i); });
        return m;
      })
      .catch(() => new Map());
  }
  return wordsPromise;
}

const WORD = /[A-Za-zÄÖÜäöüß]+(?:[-'’][A-Za-zÄÖÜäöüß]+)*/g;

// Typische Verwechslungen der Texterkennung (in beide Richtungen)
const CONFUSE = [
  ['i', 'l'], ['i', 't'], ['l', 't'], ['i', 'j'], ['l', 'I'], ['i', 'I'], ['f', 't'], ['r', 't'],
  ['n', 'u'], ['n', 'h'], ['n', 'r'], ['m', 'rn'], ['m', 'nn'], ['m', 'n'], ['w', 'vv'], ['d', 'cl'],
  ['e', 'c'], ['e', 'o'], ['a', 'o'], ['c', 'o'], ['a', 'e'], ['v', 'y'], ['u', 'v'], ['g', 'q'],
  ['ü', 'ii'], ['ü', 'u'], ['ä', 'a'], ['ö', 'o'], ['ü', 'ä'], ['ß', 'B'], ['ß', 'fs'], ['h', 'b'],
  ['S', 's'], ['C', 'c'], ['O', 'o'], ['V', 'v'], ['W', 'w'], ['Z', 'z'], ['K', 'k'], ['P', 'p'],
  ['rn', 'm'], ['ri', 'n'], ['li', 'h'], ['ni', 'm'], ['fi', 'h'],
];
const SWAP = new Map();
for (const [a, b] of CONFUSE) {
  if (!SWAP.has(a)) SWAP.set(a, new Set()); SWAP.get(a).add(b);
  if (!SWAP.has(b)) SWAP.set(b, new Set()); SWAP.get(b).add(a);
}
const ALPHA = 'abcdefghijklmnopqrstuvwxyzäöüß';

const lc = (w) => w.toLowerCase();
const caseLike = (orig, w) => (/^\p{Lu}/u.test(orig) && !/^\p{Lu}/u.test(w) ? w[0].toUpperCase() + w.slice(1) : w);

// Kandidaten mit einer typischen Verwechslung → [{ w, typical }]
function confusionEdits(w) {
  const out = new Map();
  for (let i = 0; i < w.length; i++) {
    for (const len of [1, 2]) {
      const part = w.slice(i, i + len);
      if (part.length !== len) continue;
      const rep = SWAP.get(part);
      if (!rep) continue;
      for (const r of rep) out.set(w.slice(0, i) + r + w.slice(i + len), true);
    }
  }
  return out;
}
// alle Bearbeitungen mit Abstand 1 (für Vorschläge in der Prüfliste)
function allEdits(w) {
  const out = new Set();
  const l = lc(w);
  for (let i = 0; i <= l.length; i++) {
    if (i < l.length) out.add(l.slice(0, i) + l.slice(i + 1));
    for (const c of ALPHA) {
      out.add(l.slice(0, i) + c + l.slice(i));
      if (i < l.length) out.add(l.slice(0, i) + c + l.slice(i + 1));
    }
  }
  return out;
}

// Wörter eines Seitentexts (ohne Markdown) mit Position
export function tokens(text) {
  const plain = stripMd(text || '');
  return [...plain.matchAll(WORD)].map((m) => m[0]);
}

// Analyse eines Buchs.
// pages: [{ id, text, uncertain }]; ignored: Wörter, die als richtig bestätigt wurden
// → { fixes: [{ pageId, from, to }], review: [{ pageId, word, suggestion, context }] }
export async function analyzeBook(pages, { ignored = [] } = {}) {
  const dict = await loadWordlist();
  const ign = new Set(ignored.map(lc));
  // Häufigkeiten im Buch (genaue Schreibung und kleingeschrieben)
  const exact = new Map(), lower = new Map();
  const perPage = pages.map((p) => ({ p, words: p.text ? tokens(p.text) : [] }));
  for (const { words } of perPage) for (const w of words) {
    exact.set(w, (exact.get(w) || 0) + 1);
    lower.set(lc(w), (lower.get(lc(w)) || 0) + 1);
  }
  const rank = (w) => (dict.has(lc(w)) ? dict.get(lc(w)) : Infinity);
  const inDict = (w) => dict.has(lc(w));
  // Zusammensetzungen: „Hobelbank“ = „Hobel“ + „bank“ (auch mit Fugen-s)
  const compound = (w) => {
    const l = lc(w);
    if (l.length < 8) return false;
    for (let i = 3; i <= l.length - 3; i++) {
      const a = l.slice(0, i), b = l.slice(i);
      if ((dict.has(a) || (a.endsWith('s') && dict.has(a.slice(0, -1))) || (lower.get(a) || 0) >= 2) && (dict.has(b) || (lower.get(b) || 0) >= 2)) return true;
    }
    return false;
  };
  const known = (w) => {
    if (w.length < 2 || ign.has(lc(w))) return true;
    if (inDict(w) || (lower.get(lc(w)) || 0) >= 3) return true;
    if (w.includes('-') || w.includes('’') || w.includes("'")) return w.split(/[-'’]/).every((x) => !x || known(x));
    if (/^\p{Lu}+$/u.test(w) && w.length <= 4) return true; // Abkürzungen
    return compound(w);
  };
  // Wie „sicher“ ein Ersatzwort ist: häufig im Buch oder häufiges Wörterbuchwort
  const strength = (c) => {
    const n = lower.get(lc(c)) || 0;
    const r = rank(c);
    return n * 1000 + (r < Infinity ? Math.max(0, 60000 - r) / 60 : 0);
  };

  const fixes = [], review = [];
  const decided = new Map(); // Wort → { to } | { suggestion } | null
  const decide = (w) => {
    if (decided.has(w)) return decided.get(w);
    let res = null;
    if (!known(w)) {
      // Kandidaten mit typischer Verwechslung, die sicher bekannt sind
      const typical = [...confusionEdits(w).keys()].filter((c) => c !== w && (inDict(c) || (lower.get(lc(c)) || 0) >= 2));
      typical.sort((a, b) => strength(b) - strength(a));
      const best = typical[0];
      const occurrences = exact.get(w) || 0;
      if (best) {
        const s1 = strength(best), s2 = typical[1] ? strength(typical[1]) : 0;
        const bookN = lower.get(lc(best)) || 0;
        const sure = occurrences <= 2 && (bookN >= 3 || rank(best) < 20000) && s1 > s2 * 2 && w.length >= 3;
        res = sure ? { to: caseLike(w, best) } : { suggestion: caseLike(w, best) };
      } else {
        // sonst: ähnliches Wort aus dem Buch (Abstand 1) als Vorschlag
        let sug = null, bs = 0;
        for (const c of allEdits(w)) {
          const n = lower.get(c) || 0;
          if (n >= 2 && n > bs) { bs = n; sug = c; }
        }
        if (sug) res = { suggestion: caseLike(w, sug) };
      }
    }
    decided.set(w, res);
    return res;
  };

  for (const { p, words } of perPage) {
    const unsure = new Set((p.uncertain || []).filter((u) => !ign.has(lc(u))));
    const seen = new Set();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      const d = decide(w);
      if (d && d.to) fixes.push({ pageId: p.id, from: w, to: d.to });
      else if (d && d.suggestion) review.push({ pageId: p.id, word: w, suggestion: d.suggestion, context: contextOf(p.text, w) });
      else if (unsure.has(w) && !known(w)) review.push({ pageId: p.id, word: w, suggestion: null, context: contextOf(p.text, w) });
    }
  }
  return { fixes, review };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Ganzes Wort ersetzen (nicht Teil eines längeren Worts)
export function replaceWord(text, from, to) {
  const re = new RegExp(`(^|[^\\p{L}])${esc(from)}(?![\\p{L}])`, 'gu');
  return text.replace(re, (m, pre) => pre + to);
}

// Satz um das Wort herum (für die Prüfliste)
export function contextOf(text, w) {
  const plain = stripMd(text || '').replace(/\s+/g, ' ');
  const re = new RegExp(`(^|[^\\p{L}])${esc(w)}(?![\\p{L}])`, 'u');
  const m = plain.match(re);
  if (!m) return { before: '', word: w, after: '' };
  const i = m.index + m[1].length;
  const before = plain.slice(Math.max(0, i - 60), i);
  const after = plain.slice(i + w.length, i + w.length + 60);
  return { before: (i > 60 ? '…' : '') + before, word: w, after: after + (i + w.length + 60 < plain.length ? '…' : '') };
}
