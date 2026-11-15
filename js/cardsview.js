// Lernkarten üben: eine Karte nach der anderen, aufdecken, selbst bewerten.

import * as db from './db.js';
import * as profiles from './profiles.js';
import * as lock from './lock.js';
import { collect, due, review, suspend } from './cards.js';
import { h, icon, iconButton, toast } from './ui.js';

export async function openCards(root, bookId = null) {
  const profileId = profiles.currentId();
  const canOpen = (b) => !b.locked || !lock.isConfigured() || lock.isUnlocked();
  const book = bookId ? await db.getBook(bookId) : null;
  if (book && !(await lock.ensureBookAccess(book))) { location.hash = '#/'; return; }
  const all = await collect(profileId, { bookId, canOpen });
  let queue = due(all);
  const total = queue.length;
  let done = 0, right = 0;
  const failed = new Set(); // in dieser Runde schon einmal „Nochmal“
  const stage = h('div', { class: 'card-stage' });
  const counter = h('span', { class: 'muted small' });
  const bar = h('div', { class: 'progress big' }, h('div', { style: { width: '0%' } }));

  const view = h('div', { class: 'page cards-page' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { history.length > 1 ? history.back() : (location.hash = '#/'); }),
      h('h1', { class: 'grow tr-title' }, book ? 'Lernkarten · ' + book.title : 'Lernkarten'),
      counter,
    ),
    bar,
    stage,
  );
  root.append(view);

  const progress = () => {
    counter.textContent = queue.length ? `${Math.min(done + 1, total)} / ${total}` : '';
    bar.firstChild.style.width = (total ? Math.round((done / total) * 100) : 100) + '%';
  };

  function finished() {
    progress();
    const empty = !all.length;
    stage.replaceChildren(h('div', { class: 'empty' },
      icon(empty ? 'cards' : 'check', 'big'),
      h('h3', {}, empty ? 'Noch keine Lernkarten' : total ? 'Geschafft!' : 'Heute nichts fällig'),
      h('p', { class: 'muted' }, empty
        ? 'Lernkarten entstehen aus deinen Markierungen. Markiere beim Lesen wichtige Stellen – mit einer Notiz, die auf „?“ endet, wird daraus eine Frage.'
        : total ? `${right} von ${total} gewusst. Die nächsten Karten kommen, wenn sie fällig sind.` : 'Alle Karten sind gelernt. Schau morgen wieder vorbei.'),
      h('a', { class: 'btn', href: bookId ? '#/read/' + bookId : '#/' }, bookId ? 'Zurück zum Buch' : 'Zur Bibliothek'),
    ));
  }

  function show() {
    progress();
    const c = queue[0];
    if (!c) { finished(); return; }
    const card = c.card;
    let front, back;
    if (card.kind === 'question') {
      front = h('p', { class: 'cq' }, card.question);
      back = h('blockquote', { class: 'ca' }, card.answer);
    } else if (card.kind === 'cloze') {
      front = h('p', { class: 'cq cloze' }, card.before, h('span', { class: 'gap' }, ' '.repeat(Math.min(14, card.word.length))), card.after);
      back = h('p', { class: 'cq cloze' }, card.before, h('mark', { class: 'gap-word' }, card.word), card.after);
    } else {
      front = h('p', { class: 'cq muted' }, 'Woran erinnerst du dich zu dieser Stelle?');
      back = h('blockquote', { class: 'ca' }, card.answer);
    }
    const src = h('p', { class: 'muted small card-src' }, icon('book'), ' ', c.book.title, c.rec ? ` · Fach ${c.rec.box}` : ' · neu');
    const noteEl = card.note ? h('p', { class: 'card-note' }, icon('note'), ' ', card.note) : null;
    const answer = h('div', { class: 'card-back', hidden: true }, card.kind === 'cloze' ? null : back, noteEl);
    const face = h('div', { class: 'flashcard', role: 'group', 'aria-label': 'Lernkarte' }, src, card.kind === 'cloze' ? h('div', { class: 'cloze-wrap' }, front) : front, answer);
    const actions = h('div', { class: 'card-actions' });
    const reveal = () => {
      if (card.kind === 'cloze') face.querySelector('.cloze-wrap').replaceChildren(back);
      answer.hidden = !answer.childNodes.length;
      actions.replaceChildren(
        h('button', { class: 'btn big-btn', onClick: () => grade(false) }, icon('undo'), 'Nochmal'),
        h('button', { class: 'btn primary big-btn', onClick: () => grade(true) }, icon('check'), 'Wusste ich'),
      );
      actions.querySelector('.primary').focus();
    };
    actions.append(h('button', { class: 'btn primary block big-btn', onClick: reveal }, 'Aufdecken'));
    const more = h('div', { class: 'row gap-s wrap card-more' },
      h('a', { class: 'linkish small', href: '#/read/' + c.book.id, onClick: async () => { const { setJump } = await import('./search.js'); const sg = c.hl.segs && c.hl.segs[0]; if (sg) setJump(c.book.id, { pageId: sg.pageId, p: sg.p, char: sg.start }); } }, 'Stelle im Buch zeigen'),
      h('button', { class: 'linkish small', onClick: async () => { await suspend(profileId, c.key); queue.shift(); toast('Karte wird nicht mehr abgefragt'); show(); } }, 'Nicht mehr abfragen'),
    );
    stage.replaceChildren(face, actions, more);
    actions.querySelector('button').focus();
  }

  async function grade(knew) {
    const c = queue.shift();
    await review(profileId, c.key, knew);
    if (knew) { if (!failed.has(c.key)) right++; done++; } else { failed.add(c.key); queue.push({ ...c, rec: { box: 1 } }); } // kommt in dieser Runde noch einmal
    show();
  }

  const onKey = (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const btns = stage.querySelectorAll('.card-actions button');
    if (e.key === ' ' || e.key === 'Enter') { if (btns.length === 1) { e.preventDefault(); btns[0].click(); } }
    else if (e.key === '1' && btns.length === 2) btns[0].click();
    else if (e.key === '2' && btns.length === 2) btns[1].click();
  };
  document.addEventListener('keydown', onKey);
  show();
  return () => document.removeEventListener('keydown', onKey);
}
