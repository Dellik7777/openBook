// Seite „Lesestatistik“: Kennzahlen, Lesezeit der letzten 14 Tage, meistgelesene Bücher.

import * as db from './db.js';
import * as profiles from './profiles.js';
import { getStats, dayKey } from './stats.js';
import { h, icon, iconButton, pixels, toast } from './ui.js';

const fmtMin = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} Min.`;
  return `${Math.floor(m / 60)} Std. ${m % 60} Min.`;
};

export async function openStats(root) {
  const profile = profiles.current();
  const st = await getStats(profile.id);
  const days = st.days || {};
  const now = new Date();
  const lastN = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - (n - 1 - i)); return d; });
  const secOf = (d) => (days[dayKey(d)] || {}).sec || 0;
  const week = lastN(7).reduce((s, d) => s + secOf(d), 0);
  const total = Object.values(days).reduce((s, d) => s + (d.sec || 0), 0);
  const turns = Object.values(days).reduce((s, d) => s + (d.turns || 0), 0);
  // Tage in Folge (heute zählt mit, wenn schon gelesen; sonst ab gestern)
  let streak = 0;
  const cursor = new Date(now);
  if (!secOf(cursor)) cursor.setDate(cursor.getDate() - 1);
  while (secOf(cursor) >= 60) { streak++; cursor.setDate(cursor.getDate() - 1); }

  // Tagesziel
  const goal = profile.goalMin || 0;
  let goalDays = 0;
  if (goal) {
    const c2 = new Date(now);
    if (secOf(c2) < goal * 60) c2.setDate(c2.getDate() - 1);
    while (secOf(c2) >= goal * 60) { goalDays++; c2.setDate(c2.getDate() - 1); }
  }
  const goalSeg = h('div', { class: 'segmented goal-seg', role: 'group', 'aria-label': 'Tagesziel in Minuten' },
    ...[[0, 'Aus'], [10, '10'], [20, '20'], [30, '30'], [45, '45'], [60, '60']].map(([v, l]) => h('button', {
      class: v === goal ? 'on' : '', 'aria-pressed': String(v === goal),
      onClick: async () => {
        const p = await db.getProfile(profile.id);
        p.goalMin = v || null;
        await db.putProfile(p);
        await profiles.switchTo(p.id);
        toast(v ? `Tagesziel: ${v} Minuten` : 'Tagesziel aus');
        root.replaceChildren();
        openStats(root);
      },
    }, l)));
  const goalCard = h('section', { class: 'card stat-card' },
    h('h2', { class: 'stat-h2' }, pixels('small'), 'Tagesziel'),
    goal ? h('p', { class: 'small' }, icon(secOf(now) >= goal * 60 ? 'check' : 'target'),
      secOf(now) >= goal * 60 ? ` Heute erreicht (${fmtMin(secOf(now))}).` : ` Heute ${fmtMin(secOf(now))} von ${goal} Min.`,
      ` Ziel ${goalDays === 1 ? 'an 1 Tag' : `an ${goalDays} Tagen`} in Folge erreicht.`) : h('p', { class: 'muted small' }, 'Wie viele Minuten möchtest du täglich lesen? Die Bibliothek zeigt dann deinen Fortschritt.'),
    goalSeg,
    h('p', { class: 'muted small' }, 'Minuten pro Tag'),
  );

  const tiles = h('div', { class: 'stat-tiles' },
    ...[['Heute', fmtMin(secOf(now))], ['Letzte 7 Tage', fmtMin(week)], ['Tage in Folge', String(streak)], ['Gesamt', fmtMin(total)]]
      .map(([label, value]) => h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value))));

  // Balkendiagramm: eine Reihe (Minuten pro Tag), Navy; heute beschriftet
  const series = lastN(14).map((d) => ({ d, min: Math.round(secOf(d) / 60) }));
  const max = Math.max(10, ...series.map((x) => x.min));
  const niceMax = Math.ceil(max / 10) * 10;
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const bars = h('div', { class: 'chart-bars', role: 'img', 'aria-label': 'Lesezeit der letzten 14 Tage in Minuten' },
    ...series.map(({ d, min }, i) => {
      const label = d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
      const isToday = i === series.length - 1;
      const col = h('button', { class: 'chart-col' + (isToday ? ' today' : ''), 'aria-label': `${label}: ${min} Minuten`,
        onMouseEnter: () => showTip(col, label, min), onFocus: () => showTip(col, label, min), onClick: () => showTip(col, label, min), onMouseLeave: () => { tip.hidden = true; } },
        h('span', { class: 'chart-bar', style: { height: (min / niceMax * 100) + '%' } }),
        isToday && min ? h('span', { class: 'chart-val', style: { bottom: (min / niceMax * 100) + '%' } }, `${min}`) : null,
      );
      return col;
    }));
  function showTip(col, label, min) {
    tip.hidden = false;
    tip.textContent = `${label}: ${min} Min.`;
    const r = col.getBoundingClientRect(), pr = chart.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(pr.width - 140, r.left - pr.left + r.width / 2 - 70)) + 'px';
  }
  const axis = h('div', { class: 'chart-axis' }, ...series.map(({ d }, i) => h('span', {}, i % 2 === 1 || i === series.length - 1 ? String(d.getDate()) : '')));
  const grid = h('div', { class: 'chart-grid' }, h('span', { style: { bottom: '100%' } }, `${niceMax}`), h('span', { style: { bottom: '50%' } }, `${niceMax / 2}`), h('span', { style: { bottom: '0%' } }, '0'));
  const chart = h('div', { class: 'chart' }, grid, bars, tip);
  const table = h('table', { class: 'chart-table', hidden: true },
    h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Minuten'), h('th', {}, 'Geblättert'))),
    h('tbody', {}, ...series.slice().reverse().map(({ d, min }) => h('tr', {},
      h('td', {}, d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })),
      h('td', {}, String(min)), h('td', {}, String((days[dayKey(d)] || {}).turns || 0))))));
  const toggle = h('button', { class: 'linkish small', onClick: () => { table.hidden = !table.hidden; chart.hidden = !table.hidden; axis.hidden = chart.hidden; toggle.textContent = table.hidden ? 'Als Tabelle anzeigen' : 'Als Diagramm anzeigen'; } }, 'Als Tabelle anzeigen');

  // Meistgelesene Bücher
  const perBook = new Map();
  for (const d of Object.values(days)) for (const [id, sec] of Object.entries(d.books || {})) perBook.set(id, (perBook.get(id) || 0) + sec);
  const topIds = [...perBook].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topRows = [];
  for (const [id, sec] of topIds) {
    const b = await db.getBook(id);
    if (!b) continue;
    const s = await db.getState(profile.id, id);
    const pct = Math.round(((s && s.position && s.position.ratio) || 0) * 100);
    topRows.push(h('a', { class: 'top-book', href: '#/read/' + id },
      h('span', { class: 'grow' }, h('strong', {}, b.title), h('br'), h('span', { class: 'muted small' }, `${fmtMin(sec)} gelesen · ${pct} %`)),
      h('span', { class: 'mini-progress' }, h('span', { style: { width: pct + '%' } }))));
  }

  root.append(h('div', { class: 'page stats' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { history.length > 1 ? history.back() : (location.hash = '#/'); }),
      h('h1', { class: 'grow tr-title' }, 'Lesestatistik'),
    ),
    h('p', { class: 'muted small' }, `Profil „${profile.name}“ · gezählt wird die Zeit, in der du liest oder vorlesen lässt (nur auf diesem Gerät).`),
    tiles,
    goalCard,
    h('section', { class: 'card stat-card' },
      h('div', { class: 'row between' }, h('h2', { class: 'stat-h2' }, pixels('small'), 'Lesezeit, letzte 14 Tage'), h('span', { class: 'muted small' }, 'Minuten')),
      chart, axis, table, toggle,
    ),
    h('section', { class: 'card stat-card' },
      h('h2', { class: 'stat-h2' }, pixels('small'), 'Meistgelesen'),
      topRows.length ? h('div', { class: 'stack-s' }, ...topRows) : h('p', { class: 'muted small' }, 'Noch keine Lesezeit erfasst.'),
      h('p', { class: 'muted small' }, `Insgesamt ${turns} Seiten umgeblättert.`),
    ),
  ));
}
