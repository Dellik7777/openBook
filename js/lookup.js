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

export function openLookup(rawTerm) {
  const term = cleanTerm(rawTerm).slice(0, 80);
  if (!term) return;
  const result = h('div', { class: 'lookup-result' });
  const load = async () => {
    if (!navigator.onLine) { result.replaceChildren(h('p', { class: 'muted small' }, 'Offline – Nachschlagen braucht eine Internetverbindung.')); return; }
    result.replaceChildren(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Suche bei Wikipedia …'));
    try {
      const r = await wikiSummary(term);
      if (!r) { result.replaceChildren(h('p', { class: 'muted small' }, `Kein Wikipedia-Artikel zu „${term}“ gefunden.`)); return; }
      result.replaceChildren(
        h('h3', { class: 'lookup-title' }, r.title, r.guessed ? h('span', { class: 'muted small' }, ' (ähnlicher Begriff)') : null),
        h('p', { class: 'lookup-extract' }, r.extract.length > 700 ? r.extract.slice(0, 700).replace(/\s\S*$/, '') + ' …' : r.extract),
        h('p', { class: 'muted small' }, 'Quelle: ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Wikipedia'), ' · CC BY-SA 4.0'),
      );
    } catch (e) {
      result.replaceChildren(h('p', { class: 'muted small' }, 'Nachschlagen nicht möglich: ' + e.message));
    }
  };
  sheet('Nachschlagen', h('div', { class: 'stack' },
    h('p', { class: 'lookup-term' }, icon('search'), ' ', h('strong', {}, term)),
    result,
    h('div', { class: 'row gap-s wrap' }, ...links(term).map(([label, url]) => h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener noreferrer' }, label))),
    h('p', { class: 'muted small' }, 'Beim Nachschlagen wird nur das markierte Wort an Wikipedia bzw. das gewählte Wörterbuch gesendet.'),
  ));
  load();
}
