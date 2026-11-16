// Wort nachschlagen: Kurzartikel aus Wikipedia (nur auf Wunsch, online) und Links zu
// Wörterbüchern bzw. Übersetzung, die im Browser geöffnet werden.

import { h, icon, sheet } from './ui.js';

const WIKI = 'https://de.wikipedia.org';

function cleanTerm(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
}

async function getJson(url, ms = 7000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } finally { clearTimeout(timer); }
}

// → { title, extract, url, thumb } oder null
export async function wikiSummary(term) {
  const tries = [term];
  if (term.length > 1) {
    const cap = term[0].toUpperCase() + term.slice(1);
    if (cap !== term) tries.push(cap);
  }
  for (const t of tries) {
    const j = await getJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`).catch(() => null);
    if (j && j.extract && j.type !== 'disambiguation') return { title: j.title, extract: j.extract, url: j.content_urls && j.content_urls.mobile ? j.content_urls.mobile.page : `${WIKI}/wiki/${encodeURIComponent(j.title)}` };
    if (j && j.type === 'disambiguation') return { title: j.title, extract: j.extract || 'Der Begriff hat mehrere Bedeutungen.', url: `${WIKI}/wiki/${encodeURIComponent(j.title)}`, ambiguous: true };
  }
  // Suche (z. B. gebeugte Formen: „Zyklen“ → „Zyklus“)
  const s = await getJson(`${WIKI}/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=1&namespace=0&format=json&origin=*`).catch(() => null);
  const hit = s && s[1] && s[1][0];
  if (hit && hit.toLowerCase() !== term.toLowerCase()) {
    const j = await getJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(hit.replace(/ /g, '_'))}`).catch(() => null);
    if (j && j.extract) return { title: j.title, extract: j.extract, url: `${WIKI}/wiki/${encodeURIComponent(j.title)}`, guessed: true };
  }
  return null;
}

export function links(term) {
  const q = encodeURIComponent(term);
  return [
    ['Duden', `https://www.duden.de/suchen/dudenonline/${q}`],
    ['DWDS', `https://www.dwds.de/wb/${q}`],
    ['Wiktionary', `https://de.wiktionary.org/wiki/${q}`],
    ['Übersetzen', `https://www.deepl.com/translator#de/en/${q}`],
  ];
}

// Nachgeschlagene Kurzartikel bleiben gespeichert (auch offline wieder abrufbar)
const CACHE_KEY = 'ob.lookupCache';
function cacheGet(term) {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); return c[term.toLowerCase()] || null; } catch (e) { return null; }
}
function cachePut(term, r) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    c[term.toLowerCase()] = { ...r, at: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > 300) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - 300).forEach((k) => delete c[k]);
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch (e) { /* voll → egal */ }
}

// opts.occurrences(term) → [{ before, word, after, go() }]: Fundstellen im aktuellen Buch
export function openLookup(rawTerm, { occurrences = null } = {}) {
  const term = cleanTerm(rawTerm).slice(0, 80);
  if (!term) return;
  const result = h('div', { class: 'lookup-result' });
  let s = null;
  const inBook = occurrences ? occurrences(term) : [];
  const bookBox = inBook.length > 1 ? h('div', { class: 'stack lookup-book' },
    h('h4', { class: 'voice-head' }, `Im Buch (${inBook.length >= 6 ? 'mehr als 5' : inBook.length}×)`),
    ...inBook.slice(0, 5).map((o) => h('button', { class: 'menu-item lookup-hit', onClick: () => { s && s.close(); o.go(); } },
      h('span', {}, o.before, h('mark', {}, o.word), o.after)))) : null;
  const load = async () => {
    const cached = cacheGet(term);
    if (!navigator.onLine) {
      if (cached) { show(cached, true); return; }
      result.replaceChildren(h('p', { class: 'muted small' }, 'Offline – dieses Wort wurde noch nie nachgeschlagen. Wikipedia braucht eine Internetverbindung; bereits nachgeschlagene Wörter sind auch offline verfügbar.'));
      return;
    }
    if (cached && Date.now() - cached.at < 30 * 86400000) { show(cached, false); return; }
    result.replaceChildren(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Suche bei Wikipedia …'));
    try {
      const r = await wikiSummary(term);
      if (!r) { result.replaceChildren(h('p', { class: 'muted small' }, `Kein Wikipedia-Artikel zu „${term}“ gefunden.`)); return; }
      cachePut(term, r);
      show(r, false);
    } catch (e) {
      if (cached) { show(cached, true); return; }
      result.replaceChildren(h('p', { class: 'muted small' }, 'Nachschlagen nicht möglich: ' + e.message));
    }
  };
  function show(r, offline) {
      result.replaceChildren(
        h('h3', { class: 'lookup-title' }, r.title, r.guessed ? h('span', { class: 'muted small' }, ' (ähnlicher Begriff)') : null),
        h('p', { class: 'lookup-extract' }, r.extract.length > 700 ? r.extract.slice(0, 700).replace(/\s\S*$/, '') + ' …' : r.extract),
        h('p', { class: 'muted small' }, 'Quelle: ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Wikipedia'), ' · CC BY-SA 4.0', offline ? ' · gespeichert (offline)' : ''),
      );
  }
  s = sheet('Nachschlagen', h('div', { class: 'stack' },
    h('p', { class: 'lookup-term' }, icon('search'), ' ', h('strong', {}, term)),
    bookBox,
    result,
    h('div', { class: 'row gap-s wrap' }, ...links(term).map(([label, url]) => h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener noreferrer' }, label))),
    h('p', { class: 'muted small' }, 'Beim Nachschlagen wird nur das markierte Wort an Wikipedia bzw. das gewählte Wörterbuch gesendet.'),
  ));
  load();
}
