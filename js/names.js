// Namen im Buch (Personen und Orte) finden – ohne KI, auf dem Gerät.
//
// Deutsche Hauptwörter werden auch großgeschrieben; Namen erkennt man daran, dass sie
//  - mitten im Satz großgeschrieben stehen,
//  - meist OHNE Artikel davor („sagte Marlene“, nicht „der Wein“),
//  - nie kleingeschrieben vorkommen,
//  - oft paarweise auftreten („Albrecht Wendt“).

import { loadWordlist } from './proofread.js';

const CAP = /[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?/g;
const ARTICLE = new Set(('der die das den dem des ein eine einen einem einer eines kein keine keinen keinem keiner mein meine meinen meinem meiner '
  + 'dein deine deinen deinem sein seine seinen seinem seiner ihr ihre ihren ihrem ihrer unser unsere unseren unserem euer eure '
  + 'dieser diese dieses diesen diesem jener jene jenes jeden jedem jeder jedes welcher welche welches zum zur im am beim vom ins ans aufs '
  + 'alle allen aller viele vielen einige einigen manche wenige etwas viel mehr wenig zwei drei vier fünf sechs sieben acht neun zehn zwölf zwanzig hundert tausend').split(' '));
// Anreden/Titel vor einem Wort sprechen für einen Namen („Meister Hollmann“, „Frau Brückner“)
const TITLES = new Set('Herr Herrn Frau Fräulein Meister Doktor Dr Professor Prof Kommissar Kommissarin Inspektor Onkel Tante Oma Opa Pfarrer Graf Gräfin König Königin Lieber Liebe'.split(' '));
// gebeugtes Adjektiv („alten“, „kleine“) – aber keine Verben im Präteritum („fragte“, „sagten“)
// und keine häufigen Wörter mit gleicher Endung
const NOT_ADJ = new Set('aber oder wieder immer über unter hinter später außer weder sondern ohne gegen seine eine keine meine deine ihre unsere euere jede welche alle diese jene sehr gerne lange schon heute morgen gestern daher wohin woher denen deren dessen hatte wurde würde wäre hätte habe werde könne müsse solle wolle sage frage'.split(' '));
const isAdjective = (w) => /^[a-zäöüß]{3,}(e|en|er|es|em)$/.test(w) && !/(te|ten|tet)$/.test(w) && !NOT_ADJ.has(w);
const STOP = new Set(('Sie Ihr Ihre Ihnen Ihren Ihrem Ihrer Herr Herrn Frau Fräulein Doktor Dr Gott Mama Papa Mami Papi Oma Opa Onkel Tante '
  + 'Montag Dienstag Mittwoch Donnerstag Freitag Samstag Sonntag Januar Februar März April Mai Juni Juli August September Oktober November Dezember '
  + 'Kapitel Teil Seite Abbildung Tabelle Ja Nein Okay Bitte Danke Hallo Gut Also Aber Und Oder Doch Dann Nun').split(' '));

// texts: [{ text }] (z. B. der Lesefluss) → [{ name, count, first: { i, char }, hits: [{ i, char }] }], häufigste zuerst
export async function findNames(texts, { min = 3 } = {}) {
  const dict = await loadWordlist();
  const stats = new Map(); // Wort → { total, mid, art, hits }
  const lowerSeen = new Set();
  const pairs = new Map();
  texts.forEach((t, i) => {
    const s = t.text || '';
    for (const m of s.matchAll(/[a-zäöüß]{3,}/g)) lowerSeen.add(m[0]);
    let prevTok = null;
    for (const m of s.matchAll(CAP)) {
      const w = m[0], at = m.index;
      const before = s.slice(Math.max(0, at - 40), at);
      const ctx = before.replace(/[»«„“"‚‘’'(\[–—\s]+$/u, '');
      const initial = !ctx || /[.!?:…;]$/.test(ctx);
      const prevWord = (ctx.match(/([A-Za-zÄÖÜäöüß]+)$/) || [])[1] || '';
      let st = stats.get(w);
      if (!st) { st = { total: 0, mid: 0, art: 0, title: 0, hits: [] }; stats.set(w, st); }
      st.total++;
      st.hits.push({ i, char: at });
      if (!initial) {
        st.mid++;
        if (TITLES.has(prevWord)) st.title++;
        else if (ARTICLE.has(prevWord.toLowerCase()) || isAdjective(prevWord)) st.art++; // Artikel oder Adjektiv davor
        else if (/^[A-ZÄÖÜ]/.test(prevWord) && dict.has(prevWord.toLowerCase()) && (dict.get(prevWord.toLowerCase()) < 5000)) st.art++; // „Stück Holz“
      }
      // Paare „Vorname Nachname“ (nur durch ein Leerzeichen getrennt)
      if (prevTok && prevTok.end + 1 === at && s[prevTok.end] === ' ') {
        const k = prevTok.w + ' ' + w;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
      prevTok = { w, end: at + w.length };
    }
  });
  const isName = (w, st) => {
    if (STOP.has(w) || w.length < 3) return false;
    if (lowerSeen.has(w.toLowerCase())) return false;           // kommt auch klein vor → normales Wort
    if (st.total < min) return false;
    const artRatio = st.mid ? st.art / st.mid : 0;
    const r = dict.has(w.toLowerCase()) ? dict.get(w.toLowerCase()) : Infinity;
    if (r < 5000 && !st.title) return st.art === 0 && st.mid >= 3; // sehr häufiges Wort: nur wenn nie mit Artikel („nach Hamburg“)
    if (st.title && artRatio <= 0.34) return true;              // „Meister Hollmann“
    if (r === Infinity) return artRatio <= 0.34 && (st.mid >= 1 || st.total >= 4);
    return st.mid >= 3 && artRatio <= 0.34;                     // seltene Wörterbuchwörter (viele Vornamen)
  };
  const names = [];
  for (const [w, st] of stats) if (isName(w, st)) names.push({ name: w, count: st.total, hits: st.hits });
  // Vollständige Namen: häufiges Paar → Anzeige „Albrecht Wendt“, Nachname wird mitgezählt
  const byName = new Map(names.map((n) => [n.name, n]));
  for (const [k, c] of pairs) {
    const [a, b] = k.split(' ');
    const na = byName.get(a);
    if (!na || c < 2) continue;
    if (c >= Math.max(2, na.count * 0.25)) {
      na.full = na.full || k;
      const nb = byName.get(b);
      if (nb && !nb.merged) {
        // Nachname allein zählt zur Person (ohne doppelte Stellen)
        const seen = new Set(na.hits.map((x) => x.i + ':' + x.char));
        for (const hit of nb.hits) {
          const key = hit.i + ':' + (hit.char - a.length - 1);
          if (!seen.has(key)) na.hits.push(hit);
        }
        na.count = na.hits.length;
        nb.merged = true;
      }
    }
  }
  const out = names.filter((n) => !n.merged).map((n) => {
    n.hits.sort((x, y) => x.i - y.i || x.char - y.char);
    return { name: n.full || n.name, key: n.name, count: n.hits.length, first: n.hits[0], hits: n.hits };
  });
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}
