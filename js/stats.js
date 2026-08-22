// Pure statistics over stored rows. No DOM, no IO.

const DAY = 86_400_000;

export const SRS_GROUPS = [
  { key: 'apprentice', label: 'Apprentice', stages: [1, 2, 3, 4] },
  { key: 'guru', label: 'Guru', stages: [5, 6] },
  { key: 'master', label: 'Master', stages: [7] },
  { key: 'enlightened', label: 'Enlightened', stages: [8] },
  { key: 'burned', label: 'Burned', stages: [9] },
];

export const TYPES = [
  { key: 'radical', label: 'Radicals' },
  { key: 'kanji', label: 'Kanji' },
  { key: 'vocabulary', label: 'Vocabulary' },
];

export function srsGroup(stage) {
  if (stage <= 0) return null;
  return SRS_GROUPS.find((g) => g.stages.includes(stage))?.key ?? null;
}

/** kana_vocabulary is folded into vocabulary everywhere in the UI. */
export function normType(t) {
  return t === 'kana_vocabulary' ? 'vocabulary' : t;
}

export function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / DAY;
}

/**
 * Days spent on each user level.
 * A level may have several progressions (after a reset); abandoned ones are kept, flagged.
 * @returns {{level:number, days:number, current:boolean, abandoned:boolean, unlocked_at:string}[]}
 */
export function levelDurations(progressions, now = new Date()) {
  const rows = [];
  for (const p of progressions) {
    if (!p.unlocked_at) continue;
    const end = p.passed_at ?? p.abandoned_at ?? now;
    rows.push({
      level: p.level,
      days: daysBetween(p.unlocked_at, end),
      current: !p.passed_at && !p.abandoned_at,
      abandoned: !!p.abandoned_at,
      unlocked_at: p.unlocked_at,
    });
  }
  rows.sort((a, b) => a.level - b.level || a.unlocked_at.localeCompare(b.unlocked_at));
  return rows;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Next-level and level-60 projection from the median pace of the last N completed levels.
 */
export function projection(progressions, currentLevel, now = new Date(), window = 10) {
  const rows = levelDurations(progressions, now);
  const completed = rows.filter((r) => !r.current && !r.abandoned).slice(-window);
  const pace = median(completed.map((r) => r.days));
  const cur = rows.find((r) => r.current && r.level === currentLevel);
  const daysOnCurrent = cur ? cur.days : 0;
  if (pace == null) {
    return { pace: null, daysOnCurrent, nextLevelIn: null, nextLevelAt: null, level60At: null, levelsLeft: 60 - currentLevel };
  }
  const nextLevelIn = Math.max(0, pace - daysOnCurrent);
  const levelsLeft = Math.max(0, 60 - currentLevel);
  const level60In = levelsLeft === 0 ? 0 : nextLevelIn + (levelsLeft - 1) * pace;
  return {
    pace,
    daysOnCurrent,
    nextLevelIn,
    nextLevelAt: new Date(now.getTime() + nextLevelIn * DAY),
    level60At: new Date(now.getTime() + level60In * DAY),
    levelsLeft,
  };
}

/**
 * @returns {{ byType: Record<type, Record<group, number>>, total: Record<group, number> }}
 */
export function srsDistribution(assignments) {
  const byType = {};
  const total = {};
  for (const t of TYPES) byType[t.key] = Object.fromEntries(SRS_GROUPS.map((g) => [g.key, 0]));
  for (const g of SRS_GROUPS) total[g.key] = 0;
  for (const a of assignments) {
    if (a.hidden) continue;
    const g = srsGroup(a.srs_stage);
    if (!g) continue;
    const t = normType(a.subject_type);
    if (!byType[t]) continue;
    byType[t][g] += 1;
    total[g] += 1;
  }
  return { byType, total };
}

/**
 * Meaning/reading accuracy per type, from lifetime review_statistics counters.
 * @returns {Record<type, {meaning:number|null, reading:number|null, answers:number}>}
 */
export function accuracyByType(stats) {
  const acc = {};
  for (const t of TYPES) acc[t.key] = { mc: 0, mi: 0, rc: 0, ri: 0 };
  for (const s of stats) {
    if (s.hidden) continue;
    const t = acc[normType(s.subject_type)];
    if (!t) continue;
    t.mc += s.meaning_correct; t.mi += s.meaning_incorrect;
    t.rc += s.reading_correct; t.ri += s.reading_incorrect;
  }
  const out = {};
  for (const [k, v] of Object.entries(acc)) {
    const m = v.mc + v.mi, r = v.rc + v.ri;
    out[k] = {
      meaning: m ? v.mc / m : null,
      reading: r ? v.rc / r : null,
      answers: m + r,
    };
  }
  return out;
}

/** Classic leech score: incorrect / max(currentStreak,1)^1.5 */
export function leechScore(incorrect, streak) {
  if (!incorrect) return 0;
  return incorrect / Math.pow(Math.max(streak, 1), 1.5);
}

/**
 * @param {object[]} stats
 * @param {Map<number, object>} assignmentsById
 * @param {Map<number, object>} subjectsById
 */
export function leeches(stats, assignmentsById, subjectsById, { threshold = 1, limit = 50 } = {}) {
  const rows = [];
  for (const s of stats) {
    if (s.hidden) continue;
    const a = assignmentsById.get(s.subject_id);
    if (!a || a.srs_stage >= 9 || a.srs_stage === 0) continue;
    const sub = subjectsById.get(s.subject_id);
    if (!sub || sub.hidden_at) continue;
    const mScore = leechScore(s.meaning_incorrect, s.meaning_current_streak);
    const rScore = leechScore(s.reading_incorrect, s.reading_current_streak);
    const score = Math.max(mScore, rScore);
    if (score < threshold) continue;
    rows.push({
      subject_id: s.subject_id,
      type: normType(sub.object),
      characters: sub.characters,
      slug: sub.slug,
      meaning: sub.meaning,
      reading: sub.reading,
      level: sub.level,
      srs_stage: a.srs_stage,
      meaning_incorrect: s.meaning_incorrect,
      reading_incorrect: s.reading_incorrect,
      meaning_streak: s.meaning_current_streak,
      reading_streak: s.reading_current_streak,
      worst: mScore >= rScore ? 'meaning' : 'reading',
      score,
      url: sub.document_url,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** Local calendar date key YYYY-MM-DD for an ISO timestamp. */
export function dateKey(iso, tz) {
  const d = new Date(iso);
  if (tz === 'utc') return d.toISOString().slice(0, 10);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Per-day aggregates for the last `days` days.
 * @param {object[]} srsEvents     {to, from, at}
 * @param {object[]} reviewEvents  {at, reviews}
 * @param {string[]} syncDates     ISO timestamps of syncs (to mark gap days)
 * @returns {{date:string, reviews:number, ups:Record<group,number>, downs:Record<group,number>, upTotal:number, downTotal:number, synced:boolean}[]}
 */
export function dailySeries(srsEvents, reviewEvents, syncDates, days = 90, now = new Date(), tz) {
  const byDate = new Map();
  const emptyGroups = () => Object.fromEntries(SRS_GROUPS.map((g) => [g.key, 0]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY);
    const key = dateKey(d.toISOString(), tz);
    byDate.set(key, { date: key, reviews: 0, ups: emptyGroups(), downs: emptyGroups(), upTotal: 0, downTotal: 0, synced: false });
  }
  for (const e of reviewEvents) {
    const row = byDate.get(dateKey(e.at, tz));
    if (row) row.reviews += e.reviews;
  }
  for (const e of srsEvents) {
    const row = byDate.get(dateKey(e.at, tz));
    if (!row) continue;
    if (e.to > e.from) {
      row.upTotal += 1;
      const g = srsGroup(e.to); if (g) row.ups[g] += 1;
    } else if (e.to < e.from) {
      row.downTotal += 1;
      const g = srsGroup(e.to); if (g) row.downs[g] += 1;
    }
  }
  for (const s of syncDates) {
    const row = byDate.get(dateKey(s, tz));
    if (row) row.synced = true;
  }
  return [...byDate.values()];
}

/** Reviews due per day for the next `days` days (from assignments.available_at). */
export function upcomingReviews(assignments, days = 7, now = new Date(), tz) {
  const out = new Map();
  for (let i = 0; i < days; i++) {
    const key = dateKey(new Date(now.getTime() + i * DAY).toISOString(), tz);
    out.set(key, { date: key, count: 0 });
  }
  let overdue = 0;
  for (const a of assignments) {
    if (a.hidden || !a.available_at || a.srs_stage >= 9 || a.srs_stage === 0) continue;
    const t = new Date(a.available_at);
    if (t <= now) { overdue += 1; continue; }
    const row = out.get(dateKey(a.available_at, tz));
    if (row) row.count += 1;
  }
  return { overdue, days: [...out.values()] };
}
