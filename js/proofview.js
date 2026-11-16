// Prüfliste eines Buchs: eindeutige Lesefehler werden automatisch korrigiert (rückgängig machbar),
// zweifelhafte Wörter einzeln mit Foto-Ausschnitt angezeigt.

import * as db from './db.js';
import * as lock from './lock.js';
import { analyzeBook, replaceWord } from './proofread.js';
import { h, icon, iconButton, toast, promptDialog } from './ui.js';

async function applyChange(pageId, from, to) {
  const page = await db.getPage(pageId, { images: false });
  if (!page || !page.text) return null;
  const text = replaceWord(page.text, from, to);
  if (text === page.text) return null;
  const uncertain = (page.uncertain || []).filter((u) => u !== from);
  await db.updatePage(pageId, { text, uncertain });
  return { pageId, text: page.text, uncertain: page.uncertain || [] };
}

// Prüfung starten (z. B. aus der Buchansicht) → { fixed, review }
export async function runProof(bookId) {
  const book = await db.getBook(bookId);
  const pages = (await db.getPagesMeta(bookId, { images: false })).filter((p) => p.ocrStatus === 'done' && p.text);
  return { book, pages, ...(await analyzeBook(pages, { ignored: book.proofIgnore || [] })) };
}

export async function openProof(root, bookId) {
  let book = await db.getBook(bookId);
  if (!book || !(await lock.ensureBookAccess(book))) { location.hash = '#/'; return; }
  const body = h('div', { class: 'stack proof-body' }, h('p', { class: 'muted' }, 'Prüfe den Text …'));
  const view = h('div', { class: 'page proof-page' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { location.hash = '#/book/' + bookId; }),
      h('h1', { class: 'grow tr-title' }, 'Text prüfen · ' + book.title),
    ),
    body,
  );
  root.append(view);
  const urls = [];
  const cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));

  const res = await runProof(bookId);
  const pagesById = new Map(res.pages.map((p) => [p.id, p]));
  const pageNo = (id) => { const i = res.pages.findIndex((p) => p.id === id); const p = res.pages[i]; return p && p.printedNo ? `S. ${p.printedNo}` : `Foto ${i + 1}`; };

  // 1) Eindeutige Fälle sofort korrigieren
  const undo = [];
  for (const f of res.fixes) {
    const u = await applyChange(f.pageId, f.from, f.to);
    if (u) undo.push(u);
  }
  const fixedWords = [...new Map(res.fixes.map((f) => [f.from, f.to])).entries()];

  // 2) Prüfliste nach Wort gruppieren
  const groups = new Map();
  for (const r of res.review) {
    if (!groups.has(r.word)) groups.set(r.word, { word: r.word, suggestion: r.suggestion, items: [] });
    groups.get(r.word).items.push(r);
  }
  const list = [...groups.values()];

  const autoCard = fixedWords.length ? h('div', { class: 'card proof-auto' },
    h('strong', {}, icon('check'), ` ${fixedWords.length} ${fixedWords.length === 1 ? 'Lesefehler' : 'Lesefehler'} automatisch korrigiert`),
    h('p', { class: 'small proof-fixed' }, fixedWords.map(([a, b]) => `${a} → ${b}`).join(' · ')),
    h('button', { class: 'btn small', onClick: async (e) => {
      for (const u of undo) await db.updatePage(u.pageId, { text: u.text, uncertain: u.uncertain });
      // die rückgängig gemachten Wörter als „richtig“ merken, damit sie nicht wieder korrigiert werden
      await db.updateBook(bookId, (b) => ({ proofIgnore: [...new Set([...(b.proofIgnore || []), ...fixedWords.map(([a]) => a)])] }));
      e.target.closest('.proof-auto').replaceChildren(h('span', {}, 'Rückgängig gemacht.'));
    } }, icon('undo'), 'Rückgängig'),
  ) : null;

  const counter = h('p', { class: 'muted small' });
  const setCount = () => {
    const n = listEl.querySelectorAll('.proof-item').length;
    counter.textContent = n ? `${n} ${n === 1 ? 'Stelle' : 'Stellen'} zum Ansehen` : '';
    if (!n) listEl.replaceChildren(h('div', { class: 'empty' }, icon('check', 'big'), h('h3', {}, 'Alles geprüft'), h('p', { class: 'muted' }, 'Keine weiteren zweifelhaften Wörter gefunden.')));
  };
  const listEl = h('div', { class: 'stack' });

  async function crop(pageId, word) {
    const page = await db.getPage(pageId, { images: false });
    const line = (page && page.lines || []).find((l) => l.t.includes(word));
    if (!line) return null;
    const blob = await db.pageImage(page);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const lh = (line.y1 - line.y0) * H;
    const x0 = Math.max(0, line.x0 * W - lh), x1 = Math.min(W, line.x1 * W + lh);
    const y0 = Math.max(0, line.y0 * H - lh * 1.2), y1 = Math.min(H, line.y1 * H + lh * 1.2);
    const c = document.createElement('canvas');
    const k = Math.min(1, 700 / (x1 - x0));
    c.width = Math.round((x1 - x0) * k); c.height = Math.round((y1 - y0) * k);
    c.getContext('2d').drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    c.className = 'proof-crop';
    return c;
  }

  for (const g of list) {
    const first = g.items[0];
    const ctx = first.context;
    const cropBox = h('div', { class: 'proof-cropbox' });
    const item = h('div', { class: 'card proof-item' },
      h('div', { class: 'row gap-s' }, h('strong', { class: 'grow proof-word' }, g.word),
        h('span', { class: 'muted small' }, g.items.length > 1 ? `${g.items.length} Seiten` : pageNo(first.pageId))),
      cropBox,
      h('p', { class: 'proof-context' }, ctx.before, h('mark', {}, ctx.word), ctx.after),
      h('div', { class: 'row gap-s wrap' },
        g.suggestion ? h('button', { class: 'btn small primary', onClick: () => change(g.suggestion) }, icon('check'), `„${g.suggestion}“`) : null,
        h('button', { class: 'btn small', onClick: async () => {
          const v = await promptDialog('Wort ändern', `Richtige Schreibweise für „${g.word}“:`, { value: g.suggestion || g.word, okLabel: 'Ändern' });
          if (v && v.trim() && v.trim() !== g.word) change(v.trim());
        } }, icon('edit'), 'Ändern'),
        h('button', { class: 'btn small', onClick: async () => {
          await db.updateBook(bookId, (b) => ({ proofIgnore: [...new Set([...(b.proofIgnore || []), g.word])] }));
          for (const it of g.items) {
            const p = pagesById.get(it.pageId);
            if (p && (p.uncertain || []).includes(g.word)) await db.updatePage(it.pageId, { uncertain: p.uncertain.filter((u) => u !== g.word) });
          }
          done();
        } }, 'Richtig so'),
        h('a', { class: 'linkish small', href: `#/page/${bookId}/${first.pageId}` }, 'Seite öffnen'),
      ),
    );
    const done = () => { item.remove(); setCount(); };
    const change = async (to) => {
      let n = 0;
      for (const it of g.items) if (await applyChange(it.pageId, g.word, to)) n++;
      toast(n ? `„${g.word}“ → „${to}“` : 'Nichts geändert');
      done();
    };
    listEl.append(item);
    crop(first.pageId, g.word).then((c) => { if (c) cropBox.append(c); }).catch(() => {});
  }

  body.replaceChildren(
    autoCard,
    h('p', { class: 'muted small' }, 'Lesepixel vergleicht jedes Wort mit dem Rest des Buchs und einer deutschen Wortliste. Eindeutige Lesefehler werden sofort korrigiert, bei den übrigen Stellen entscheidest du.'),
    counter,
    listEl,
  );
  setCount();
  return cleanup;
}
