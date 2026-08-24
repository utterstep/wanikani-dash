// DOM rendering of the computed model.

import { columnChart, divergingChart, stackedBars, legend } from './charts.js';
import {
  SRS_GROUPS, TYPES, levelDurations, projection, srsDistribution, accuracyByType,
  leeches, dailySeries, upcomingReviews, median, dateKey,
} from './stats.js';
import { KANKEN_LEVELS, KANJI_STATES, kankenCoverage, selectableLevel, nonJoyoWaniKani } from './kanken.js';
import { gradeOf } from './kanji-grades.js';

const $ = (id) => document.getElementById(id);
const widthOf = (id) => Math.max(320, Math.floor($(id).clientWidth || $(id).parentElement.clientWidth || 640));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDays = (d) => (d == null ? '—' : d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1)} d`);
const shortDay = (key) => { const [, m, d] = key.split('-'); return `${Number(d)}/${Number(m)}`; };
const STAGE_NAME = ['Locked', 'Apprentice I', 'Apprentice II', 'Apprentice III', 'Apprentice IV', 'Guru I', 'Guru II', 'Master', 'Enlightened', 'Burned'];

export function renderAll(model, { now = new Date() } = {}) {
  renderHeader(model);
  renderActions(model);
  renderCards(model, now);
  renderSrs(model);
  renderLevels(model, now);
  renderDaily(model, now);
  renderKanken(model);
  renderAccuracy(model);
  renderUpcoming(model, now);
  renderLeeches(model);
  $('dashboard').hidden = false;
}

function renderActions(model) {
  const sm = model.summary;
  const el = $('actions');
  if (!sm) { el.innerHTML = ''; el.hidden = true; return; }
  const btns = [];
  if (sm.lessons) btns.push(`<a class="btn cta lessons" href="https://www.wanikani.com/subject-lessons/start" target="_blank" rel="noopener">Lessons <b>${sm.lessons.toLocaleString()}</b></a>`);
  if (sm.reviews) btns.push(`<a class="btn cta reviews" href="https://www.wanikani.com/subjects/review" target="_blank" rel="noopener">Reviews <b>${sm.reviews.toLocaleString()}</b></a>`);
  if (!btns.length) {
    const next = sm.next_reviews_at ? new Date(sm.next_reviews_at) : null;
    btns.push(`<span class="note">Nothing to do right now${next && next > new Date() ? ` — next reviews ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.</span>`);
  }
  el.innerHTML = btns.join('');
  el.hidden = false;
}

function renderHeader(model) {
  $('level-badge').textContent = model.user ? `Level ${model.user.level}` : '';
  $('username').textContent = model.user?.username ?? '';
  $('last-sync').textContent = model.lastSync ? `synced ${new Date(model.lastSync).toLocaleString()}` : '';
}

function renderCards(model, now) {
  const proj = projection(model.progressions, model.user?.level ?? 1, now);
  const today = dailySeries(model.srsEvents, model.reviewEvents, model.syncDates, 1, now)[0];
  const vacation = model.user?.current_vacation_started_at;
  $('cards').innerHTML = [
    card('Current level', model.user?.level ?? '—', vacation ? `on vacation since ${fmtDate(vacation)}` : `${fmtDays(proj.daysOnCurrent)} on this level`),
    card('Median pace', fmtDays(proj.pace), 'days per level, last 10 levels'),
    card('Next level', proj.nextLevelAt ? fmtDate(proj.nextLevelAt) : '—', proj.nextLevelIn != null ? `in ${fmtDays(proj.nextLevelIn)}` : 'need completed levels'),
    card('Level 60', proj.level60At ? fmtDate(proj.level60At) : '—', `${proj.levelsLeft} levels to go`),
    card('Reviews today', today.reviews.toLocaleString(), `▲${today.upTotal} ▼${today.downTotal} SRS moves`),
  ].join('');
}

function card(label, value, sub) {
  return `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value">${esc(value)}</div><div class="card-sub">${esc(sub)}</div></div>`;
}

function renderSrs(model) {
  const dist = srsDistribution(model.assignments);
  const rows = TYPES.map((t) => ({
    label: t.label,
    parts: SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: g.label, value: dist.byType[t.key][g.key] })),
  }));
  rows.push({ label: 'Total', parts: SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: g.label, value: dist.total[g.key] })) });
  $('srs-chart').innerHTML = stackedBars(rows, { title: 'SRS distribution', width: widthOf('srs-chart') }) + legend(SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: g.label })));
}

function renderLevels(model, now) {
  const rows = levelDurations(model.progressions, now);
  if (!rows.length) { $('levels-chart').innerHTML = '<p class="empty">No level data yet.</p>'; return; }
  const completed = rows.filter((r) => !r.current && !r.abandoned).map((r) => r.days);
  const med = median(completed);
  const data = rows.map((r) => ({
    label: String(r.level),
    value: +r.days.toFixed(2),
    cls: r.current ? 'level-current' : r.abandoned ? 'level-abandoned' : 'level',
    muted: r.abandoned,
    forceLabel: r.current,
    tip: `Level ${r.level}: ${fmtDays(r.days)}${r.current ? ' (current)' : ''}${r.abandoned ? ' (reset)' : ''}\nunlocked ${fmtDate(r.unlocked_at)}`,
  }));
  $('levels-chart').innerHTML = columnChart(data, {
    title: 'Days per level', height: 220, xEvery: 5, width: widthOf('levels-chart'),
    refLine: med != null ? { value: med, label: `median ${fmtDays(med)}` } : undefined,
  });
  $('levels-note').textContent = rows.some((r) => r.abandoned) ? 'Grey bars are levels abandoned by a reset.' : '';
}

function renderDaily(model, now) {
  const days = Number(localStorage.getItem('wk_days') || 60);
  const series = dailySeries(model.srsEvents, model.reviewEvents, model.syncDates, days, now);
  const since = model.historySince ? fmtDate(model.historySince) : null;
  const sinceKey = model.historySince ? dateKey(model.historySince) : '9999';
  const isGap = (d) => !d.synced && d.date > sinceKey;
  $('history-note').textContent = since ? `Review history is collected locally since ${since}. Days without a sync are shaded; their reviews land on the next sync day.` : '';

  $('reviews-chart').innerHTML = columnChart(series.map((d) => ({
    label: shortDay(d.date), value: d.reviews, cls: 'reviews', gap: isGap(d),
    tip: `${d.date}: ${d.reviews} reviews${isGap(d) ? ' (no sync that day)' : ''}`,
  })), { title: 'Reviews per day', height: 180, integer: true, width: widthOf('reviews-chart') });

  $('srs-moves-chart').innerHTML = divergingChart(series.map((d) => ({
    label: shortDay(d.date), gap: isGap(d),
    up: SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: `→ ${g.label}`, value: d.ups[g.key] })),
    down: SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: `↓ ${g.label}`, value: d.downs[g.key] })),
  })), { title: 'SRS promotions and demotions per day', height: 220, width: widthOf('srs-moves-chart') })
    + legend(SRS_GROUPS.map((g) => ({ cls: `srs-${g.key}`, name: g.label })));

  const sel = $('days-select');
  if (sel && sel.value !== String(days)) sel.value = String(days);
}

/* ---------------------------------------------------------------- Kanken --- */

export const KANKEN_KEY = 'wk_kanken';
const GRADE_TITLE = {
  1: 'Grade 1 · 小学1年', 2: 'Grade 2 · 小学2年', 3: 'Grade 3 · 小学3年',
  4: 'Grade 4 · 小学4年', 5: 'Grade 5 · 小学5年', 6: 'Grade 6 · 小学6年',
  S: 'Secondary school · 中学校以上', J: 'Jinmeiyō · 人名用漢字',
};
const GRADE_SHORT = { 1: '小1', 2: '小2', 3: '小3', 4: '小4', 5: '小5', 6: '小6', S: '中学以上', J: '人名用' };
const STATE_NAME = {
  burned: 'Burned', enlightened: 'Enlightened', master: 'Master', guru: 'Guru',
  apprentice: 'Apprentice', lesson: 'Lesson available', locked: 'Locked', absent: 'Not on WaniKani',
};
const pct = (n, d) => (!d ? '—' : n && n / d < 0.005 ? '<1%' : `${Math.round((n / d) * 100)}%`);
const passedOf = (c) => c.burned + c.enlightened + c.master + c.guru;

function renderKanken(model) {
  const sel = $('kanken-select');
  if (!sel.options.length) {
    sel.innerHTML = KANKEN_LEVELS.map((l) => {
      const n = `${l.approx ? '≈' : ''}${l.official.toLocaleString()} kanji`;
      const why = l.grades ? '' : ' — list not derivable';
      return `<option value="${l.key}"${l.grades ? '' : ' disabled'}>${esc(l.label)} · ${n}${why}</option>`;
    }).join('');
  }
  const level = selectableLevel(localStorage.getItem(KANKEN_KEY));
  sel.value = level.key;

  const cov = kankenCoverage(level.key, model.subjects, model.assignmentsById);
  $('kanken-sub').textContent = `${level.label} — ${level.sub}`;

  $('kanken-summary').innerHTML = `<div class="mini-cards">${[
    mini('At this level', cov.total.toLocaleString(), level.approx ? `≈${level.official.toLocaleString()} published` : 'kanji in scope'),
    mini('On WaniKani', cov.onWk.toLocaleString(), `${pct(cov.onWk, cov.total)} of the level`),
    mini('Passed', passedOf(cov.counts).toLocaleString(), `${pct(passedOf(cov.counts), cov.total)} at Guru or above`),
    mini('Burned', cov.burned.toLocaleString(), pct(cov.burned, cov.total)),
  ].join('')}</div>${strip(cov.counts, cov.total, level.label)}`;

  $('kanken-heat').innerHTML = cov.sections.map((sec) => `
    <div class="heat-grade">
      <div class="heat-head">
        <span class="heat-title">${esc(GRADE_TITLE[sec.grade])}</span>
        <span class="heat-sub">${sec.total.toLocaleString()} kanji · ${passedOf(sec.counts).toLocaleString()} passed (${pct(passedOf(sec.counts), sec.total)})</span>
      </div>
      ${strip(sec.counts, sec.total, GRADE_TITLE[sec.grade])}
      <div class="heat-grid">${sec.cells.map(heatCell).join('')}</div>
    </div>`).join('');

  $('kanken-legend').innerHTML = legend(KANJI_STATES.map((s) => ({ cls: `st-${s.key}`, name: s.label })));

  const outside = nonJoyoWaniKani(model.subjects, gradeOf);
  const notes = ['Sorted by WaniKani level, so the coloured front edge is how far your levels reach into each grade.'];
  if (outside.jinmeiyo.length || outside.other.length) {
    notes.push(`WaniKani also teaches ${(outside.jinmeiyo.length + outside.other.length).toLocaleString()} kanji outside the Jōyō list (${outside.jinmeiyo.length} jinmeiyō, ${outside.other.length} neither).`);
  }
  notes.push('漢検 10級–5級 are exactly 小学1年–6年 of the 常用漢字表 and 2級 is the whole list, so Jōyō grades pin them down. 4級 / 3級 / 準2級 carve the 1,110 secondary-school kanji into 313 / 284 / 328 on a list the 日本漢字能力検定協会 publishes separately — grades cannot recover it, so those are greyed out rather than guessed. 準1級 is approximated as Jōyō + Jinmeiyō (2,999 of its ~3,000 kanji).');
  notes.push('Grades from KANJIDIC2 © EDRDG, CC BY-SA 4.0.');
  $('kanken-note').innerHTML = notes.map(esc).join('<br>');
}

function mini(label, value, sub) {
  return `<div class="mini"><div class="mini-label">${esc(label)}</div><div class="mini-value">${esc(value)}</div><div class="mini-sub">${esc(sub)}</div></div>`;
}

function strip(counts, total, what) {
  const parts = KANJI_STATES.filter((s) => counts[s.key]).map((s) =>
    `<span class="hit st-${s.key}" style="flex:${counts[s.key]}" data-tip="${esc(`${what} · ${STATE_NAME[s.key]}: ${counts[s.key].toLocaleString()} (${pct(counts[s.key], total)})`)}"></span>`);
  return `<div class="strip" role="img" aria-label="${esc(`${what}: ${passedOf(counts)} of ${total} passed`)}">${parts.join('')}</div>`;
}

function heatCell(c) {
  const where = c.wkLevel ? `${GRADE_SHORT[c.grade]} · WK level ${c.wkLevel}` : `${GRADE_SHORT[c.grade]} · not on WaniKani`;
  const gloss = c.meaning ? `\n${c.meaning}${c.reading ? ` · ${c.reading}` : ''}` : '';
  const tip = `${c.ch}\n${where}\n${STATE_NAME[c.state]}${gloss}`;
  const attrs = `class="heat hit st-${c.state}" data-tip="${esc(tip)}"`;
  return c.url
    ? `<a ${attrs} href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.ch)}</a>`
    : `<span ${attrs}>${esc(c.ch)}</span>`;
}

/* ------------------------------------------------------------------------- */

function renderAccuracy(model) {
  const acc = accuracyByType(model.stats);
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  $('accuracy').innerHTML = `<table class="table"><thead><tr><th>Type</th><th>Meaning</th><th>Reading</th><th>Answers</th></tr></thead><tbody>${
    TYPES.map((t) => `<tr><td><span class="swatch type-${t.key}"></span>${t.label}</td><td>${pct(acc[t.key].meaning)}</td><td class="muted">${t.key === 'radical' ? 'n/a' : pct(acc[t.key].reading)}</td><td>${acc[t.key].answers.toLocaleString()}</td></tr>`).join('')
  }</tbody></table>`;
}

function renderUpcoming(model, now) {
  const up = upcomingReviews(model.assignments, 7, now);
  $('upcoming-chart').innerHTML = columnChart(up.days.map((d, i) => ({
    label: i === 0 ? 'today' : shortDay(d.date), value: d.count, cls: 'reviews', forceLabel: true,
    tip: `${d.date}: ${d.count} reviews become available`,
  })), { title: 'Upcoming reviews', height: 150, xEvery: 1, integer: true, width: widthOf('upcoming-chart') });
  $('upcoming-note').textContent = up.overdue ? `${up.overdue.toLocaleString()} reviews available right now.` : 'No reviews available right now.';
}

function renderLeeches(model) {
  const rows = leeches(model.stats, model.assignmentsById, model.subjectsById);
  if (!rows.length) { $('leeches').innerHTML = '<p class="empty">No leeches. 🎉</p>'; return; }
  $('leeches').innerHTML = `<table class="table leeches"><thead><tr><th>Item</th><th>Lvl</th><th>Stage</th><th>Meaning ✗/streak</th><th>Reading ✗/streak</th><th>Score</th></tr></thead><tbody>${
    rows.map((r) => `<tr>
      <td><a class="item type-${r.type}" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.characters ?? r.slug)}</a><div class="item-sub">${esc(r.meaning)}${r.reading ? ` · ${esc(r.reading)}` : ''}</div></td>
      <td>${r.level}</td><td>${esc(STAGE_NAME[r.srs_stage])}</td>
      <td class="${r.worst === 'meaning' ? 'worst' : ''}">${r.meaning_incorrect} / ${r.meaning_streak}</td>
      <td class="${r.worst === 'reading' ? 'worst' : ''}">${r.reading ? `${r.reading_incorrect} / ${r.reading_streak}` : '—'}</td>
      <td>${r.score.toFixed(1)}</td></tr>`).join('')
  }</tbody></table>`;
}

export function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

export function setProgress(info) {
  const el = $('progress');
  if (!info) { el.hidden = true; return; }
  el.hidden = false;
  if (info.kind === 'ratelimit') { el.textContent = `Rate limited — waiting ${Math.ceil(info.waitMs / 1000)}s…`; return; }
  const name = info.path.replace('/', '').replace('_', ' ');
  el.textContent = `Loading ${name}… ${info.loaded.toLocaleString()}${info.total ? ` / ${info.total.toLocaleString()}` : ''}`;
}
