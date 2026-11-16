// Prüft anhand der gedruckten Seitenzahlen, ob Seiten fehlen, doppelt oder vertauscht sind.
//
// Seiten ohne erkannte Zahl (Kapitelanfänge, Bildseiten, leere Seiten) sind normal und
// werden über den Abstand in der Reihenfolge mitgezählt. Einzelne Lesefehler der OCR
// (z. B. „74“ statt „14“) werden erkannt, wenn die Nachbarn zueinander passen.

const MAX_PLAUSIBLE_GAP = 40;

function knownNumbers(pages) {
  const known = [];
  pages.forEach((p, i) => { if (Number.isInteger(p.printedNo) && p.printedNo > 0) known.push({ i, n: p.printedNo, manual: !!p.printedNoManual }); });
  // Ausreißer entfernen: passt eine Zahl zu keinem Nachbarn, die Nachbarn aber zueinander → Lesefehler
  const fits = (a, b) => a && b && b.n - a.n === b.i - a.i;
  return known.filter((cur, k) => {
    if (cur.manual) return true;
    const prev = known[k - 1], next = known[k + 1];
    if (fits(prev, cur) || fits(cur, next)) return true;
    if (prev && next && fits(prev, next)) return false;
    // Am Rand: Die beiden Nachbarzahlen passen zueinander, und diese Zahl ist die erwartete mit
    // verschluckter Ziffer (z. B. „11“ als „1“ gelesen vor 12, 13) → Lesefehler, keine Lücke
    const next2 = known[k + 2], prev2 = known[k - 2];
    const dropped = (n, expect) => expect > 0 && String(n).length < String(expect).length && String(expect).includes(String(n));
    if (!prev && next && next2 && fits(next, next2) && dropped(cur.n, next.n - (next.i - cur.i))) return false;
    if (!next && prev && prev2 && fits(prev2, prev) && dropped(cur.n, prev.n + (cur.i - prev.i))) return false;
    // Am Rand: Sprung riesig und kein Nachbar bestätigt → vermutlich Lesefehler
    if (!next && prev && Math.abs(cur.n - prev.n - (cur.i - prev.i)) > MAX_PLAUSIBLE_GAP) return false;
    if (!prev && next && Math.abs(next.n - cur.n - (next.i - cur.i)) > MAX_PLAUSIBLE_GAP) return false;
    return true;
  });
}

// → [{ type: 'missing'|'duplicate'|'order', key, ... }]
// confirmedOnly: nur Lücken melden, die durch eine weitere passende Seite bestätigt sind
// (beim Scannen, damit ein Lesefehler auf der gerade gescannten Seite keinen Fehlalarm auslöst).
export function checkPages(pages, { ignored = [], confirmedOnly = false } = {}) {
  const known = knownNumbers(pages);
  const ign = new Set(ignored);
  const issues = [];
  const orderAt = new Set();
  for (let k = 1; k < known.length; k++) if (known[k].n < known[k - 1].n) orderAt.add(k);
  for (let k = 1; k < known.length; k++) {
    const a = known[k - 1], b = known[k];
    const dIdx = b.i - a.i, dNo = b.n - a.n;
    if (dNo === dIdx) continue;
    if (dNo === 0) {
      issues.push({ type: 'duplicate', key: `d:${a.n}:${pages[b.i].id}`, no: a.n, pageIds: [pages[a.i].id, pages[b.i].id] });
    } else if (dNo < 0) {
      issues.push({ type: 'order', key: `o:${a.n}:${b.n}`, after: a.n, no: b.n, pageId: pages[b.i].id });
    } else if (dNo > dIdx) {
      // Neben vertauschten Seiten entstehen scheinbare Lücken → nicht zusätzlich melden
      if (orderAt.has(k - 1) || orderAt.has(k + 1)) continue;
      const count = dNo - dIdx;
      const next = known[k + 1];
      const confirmed = b.manual || (next && next.n - b.n === next.i - b.i);
      if (confirmedOnly && !confirmed && count > 2) continue;
      if (count > MAX_PLAUSIBLE_GAP && !confirmed) continue;
      issues.push({
        type: 'missing',
        key: `m:${a.n}-${b.n}`,
        count,
        // Nur bei direkt aufeinanderfolgenden Seiten lässt sich genau sagen, welche fehlen
        from: dIdx === 1 ? a.n + 1 : null,
        to: dIdx === 1 ? b.n - 1 : null,
        afterNo: a.n,
        beforeNo: b.n,
        afterPageId: pages[b.i - 1].id,  // nachgescannte Seiten kommen direkt vor Seite b
        beforePageId: pages[b.i].id,
      });
    }
    // dNo < dIdx (mehr Fotos als Nummern) ist normal: Bildtafeln, leere Seiten ohne Zahl
  }
  return issues.filter((x) => !ign.has(x.key));
}

export function describe(issue) {
  if (issue.type === 'missing') {
    const what = issue.count === 1
      ? (issue.from ? `Seite ${issue.from} fehlt` : '1 Seite fehlt')
      : (issue.from ? `Seiten ${issue.from}–${issue.to} fehlen` : `${issue.count} Seiten fehlen`);
    return `${what} (zwischen ${issue.afterNo} und ${issue.beforeNo}).`;
  }
  if (issue.type === 'duplicate') return `Seite ${issue.no} ist doppelt gescannt.`;
  if (issue.type === 'order') return `Seite ${issue.no} kommt nach Seite ${issue.after} – Reihenfolge prüfen.`;
  return '';
}

// Anzeige-Seitenzahlen für den Leser: gedruckte Zahl oder aus Nachbarn abgeleitet.
// → { labels: [number|null], total: number|null }
export function displayNumbers(pages) {
  const known = knownNumbers(pages);
  const labels = pages.map(() => null);
  if (!known.length) return { labels, total: null };
  let k = 0;
  for (let i = 0; i < pages.length; i++) {
    while (k + 1 < known.length && known[k + 1].i <= i) k++;
    const ref = known[k].i <= i ? known[k] : known[0];
    const n = ref.n + (i - ref.i);
    labels[i] = n >= 1 ? n : null;
  }
  return { labels, total: labels[labels.length - 1] };
}

// Neue Reihenfolge nach gedruckter Seitenzahl. Seiten ohne Zahl bleiben hinter ihrer
// vorherigen nummerierten Seite (z. B. Bildseiten, Kapitelanfänge). → [pageId] oder null (schon richtig)
export function orderByPrinted(pages) {
  const groups = [];
  let cur = { n: -Infinity, idx: -1, ids: [] };
  groups.push(cur);
  pages.forEach((p, i) => {
    if (Number.isInteger(p.printedNo) && p.printedNo > 0) { cur = { n: p.printedNo, idx: i, ids: [p.id] }; groups.push(cur); }
    else cur.ids.push(p.id);
  });
  const sorted = [...groups].sort((a, b) => a.n - b.n || a.idx - b.idx);
  const order = sorted.flatMap((g) => g.ids);
  return order.every((id, i) => id === pages[i].id) ? null : order;
}
