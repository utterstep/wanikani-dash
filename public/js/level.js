// Level progress: the items of one WaniKani level, how close it is to the level-up
// threshold, when the level-up can happen, and how the level's kanji were passed over
// time. Pure — no DOM, no IO.
//
// WaniKani rules this encodes (docs.api.wanikani.com):
// - a level is passed once 90% of its kanji are passed (reached Guru at least once);
// - a kanji unlocks when every radical in component_subject_ids is passed;
// - after a review lands on stage s the item is next available at
//   floor_to_hour(review time + interval[s]); intervals 4h / 8h / 23h / 47h up to Guru,
//   halved-ish (2h / 4h / 8h / 23h) for subjects on levels 1–2.

import { KANJI_STATES, stateOfStage } from './kanken.js';
import { median, daysBetween, normType } from './stats.js';

export const HOUR = 3_600_000;

/** Wait before the next review, indexed by the stage the item has just entered. */
export const LADDERS = {
  default: [0, 4, 8, 23, 47].map((h) => h * HOUR),
  accelerated: [0, 2, 4, 8, 23].map((h) => h * HOUR),
};

export const PASSING_STAGE = 5;

/** Cell states of the level grid, most learned first. */
export const LEVEL_STATES = KANJI_STATES.filter((s) => s.key !== 'absent');
const STATE_INDEX = Object.fromEntries(LEVEL_STATES.map((s, i) => [s.key, i]));

export function ladderFor(subjectLevel) {
  return subjectLevel <= 2 ? LADDERS.accelerated : LADDERS.default;
}

export function floorHour(ms) {
  return ms - (ms % HOUR);
}

/** Kanji that must be passed to level up: 90%, rounded up, computed without floats (0.9 × 70 ≠ 63). */
export function neededKanji(total) {
  return total - Math.floor(total / 10);
}

/** The progression that describes the level now: latest run that was not abandoned, else the latest run. */
export function progressionFor(progressions, level) {
  const runs = progressions.filter((p) => p.level === level && p.unlocked_at).sort((a, b) => a.unlocked_at.localeCompare(b.unlocked_at));
  if (!runs.length) return null;
  return runs.filter((p) => !p.abandoned_at).at(-1) ?? runs.at(-1);
}

/**
 * Passed for level-up purposes: WaniKani counts passed_at, so a demoted Guru still counts —
 * unless the pass predates the current run of the level (a reset), which no longer does.
 */
export function isPassed(asg, progression) {
  if (asg.srs_stage >= PASSING_STAGE) return true;
  if (!asg.passed_at) return false;
  return !progression?.unlocked_at || asg.passed_at >= progression.unlocked_at;
}

const isUnlocked = (a) => !!a && !a.hidden && a.unlocked_at != null;

/** Whether an assignment belongs to this run of the level (a minute of slack for WaniKani's clocks). */
const fromRun = (a, progression) => !progression?.unlocked_at || Date.parse(a.unlocked_at) >= Date.parse(progression.unlocked_at) - 60_000;

const emptyCounts = () => Object.fromEntries(LEVEL_STATES.map((s) => [s.key, 0]));

/**
 * Every item of a level with its SRS state, grouped by type.
 * @returns {{level:number, groups:Record<type, object[]>, counts:Record<type, Record<state, number>>,
 *            kanji:{passed:number,total:number,needed:number}, radicals:{passed:number,total:number}}}
 */
export function levelItems(level, subjects, assignmentsById, now = new Date(), progression = null) {
  const nowIso = new Date(now).toISOString();
  const groups = { radical: [], kanji: [], vocabulary: [] };
  const counts = { radical: emptyCounts(), kanji: emptyCounts(), vocabulary: emptyCounts() };
  const passedOf = { radical: 0, kanji: 0, vocabulary: 0 };
  for (const s of subjects) {
    if (s.level !== level || s.hidden_at) continue;
    const type = normType(s.object);
    if (!groups[type]) continue;
    const a = assignmentsById.get(s.id);
    const unlocked = isUnlocked(a);
    const stage = unlocked ? a.srs_stage : null;
    const passed = unlocked && isPassed(a, progression);
    const item = {
      id: s.id,
      type,
      level: s.level,
      characters: s.characters,
      image: s.image ?? null,
      meaning: s.meaning,
      reading: s.reading,
      url: s.document_url,
      components: s.components ?? null,
      state: unlocked ? stateOfStage(stage) : 'locked',
      srs_stage: stage,
      passed,
      dueNow: unlocked && stage >= 1 && stage < 9 && !!a.available_at && a.available_at <= nowIso,
      available_at: unlocked ? a.available_at : null,
    };
    groups[type].push(item);
    counts[type][item.state] += 1;
    if (passed) passedOf[type] += 1;
  }
  for (const g of Object.values(groups)) {
    g.sort((a, b) => STATE_INDEX[a.state] - STATE_INDEX[b.state] || (b.srs_stage ?? -1) - (a.srs_stage ?? -1) || a.id - b.id);
  }
  return {
    level,
    groups,
    counts,
    kanji: { passed: passedOf.kanji, total: groups.kanji.length, needed: neededKanji(groups.kanji.length) },
    radicals: { passed: passedOf.radical, total: groups.radical.length },
  };
}

/**
 * When an item that has just entered `stage` at time `t` reaches Guru, if every review is done
 * the moment it becomes available. `factor` stretches every wait; `floor` applies WaniKani's
 * top-of-the-hour rounding (only the first hop can be off the hour, so per-hop flooring is exact).
 */
export function afterStage(t, stage, ladder, { factor = 1, floor = true } = {}) {
  for (let s = stage; s < PASSING_STAGE; s++) {
    const wait = ladder[s] * factor;
    t = floor ? floorHour(t + wait) : t + wait;
  }
  return t;
}

/**
 * Earliest pass time for each given kanji, following locked kanji back through their radicals.
 * @param {object[]} kanji   items from levelItems (any subset)
 * @param {{subjectsById:Map, assignmentsById:Map, now:Date|number, progression:object|null}} ctx
 * @returns {Map<number, {id:number, at:number, stage:number|null, locked:boolean, unlockAt:number|null, gateRadical:number|null}>}
 */
export function passTimes(kanji, ctx, { lessonLagMs = 0, factor = 1, floor = true } = {}) {
  const now = +new Date(ctx.now);
  const opts = { factor, floor };
  const memo = new Map();
  const passOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const sub = ctx.subjectsById.get(id);
    const a = ctx.assignmentsById.get(id);
    const unlocked = isUnlocked(a);
    const p = { id, at: Infinity, stage: unlocked ? a.srs_stage : null, locked: !unlocked, unlockAt: null, gateRadical: null };
    memo.set(id, p); // also guards against cyclic component data
    if (!sub || sub.hidden_at) return p;
    const ladder = ladderFor(sub.level);
    // The reset rule only applies to the level being looked at; a radical from a lower level is simply passed.
    const prog = ctx.progression && ctx.progression.level === sub.level ? ctx.progression : null;
    if (unlocked && isPassed(a, prog)) {
      p.at = now;
    } else if (unlocked && a.srs_stage === 0) {
      p.at = afterStage(now + lessonLagMs, 1, ladder, opts);
    } else if (unlocked) {
      const review = Math.max(a.available_at ? Date.parse(a.available_at) : now, now);
      p.at = afterStage(review, a.srs_stage + 1, ladder, opts);
    } else if (sub.object === 'kanji') {
      let unlockAt = now;
      for (const rid of sub.components ?? []) {
        if (!ctx.subjectsById.has(rid)) continue; // unknown radical: do not let a data hole block the level
        const r = passOf(rid);
        if (r.at > unlockAt) { unlockAt = r.at; p.gateRadical = rid; }
      }
      p.unlockAt = unlockAt;
      p.at = Number.isFinite(unlockAt) ? afterStage(unlockAt + lessonLagMs, 1, ladder, opts) : Infinity;
    }
    return p;
  };
  return new Map(kanji.map((k) => [k.id, passOf(k.id)]));
}

/**
 * How late the user is, measured on the last `window` completed levels' kanji:
 * lesson lag = median(started_at − unlocked_at); factor = median of (started→passed) ÷ the
 * theoretical minimum, clamped ≥ 1. Falls back to 0 / 1 without samples.
 */
export function measureLags(subjects, assignmentsById, progressions, { window = 3 } = {}) {
  const completed = progressions
    .filter((p) => p.passed_at && !p.abandoned_at && p.unlocked_at)
    .sort((a, b) => a.unlocked_at.localeCompare(b.unlocked_at))
    .slice(-window);
  const byLevel = new Map(completed.map((p) => [p.level, p]));
  const lesson = [], review = [];
  for (const s of subjects) {
    const p = byLevel.get(s.level);
    if (!p || s.object !== 'kanji' || s.hidden_at) continue;
    const a = assignmentsById.get(s.id);
    if (!isUnlocked(a) || !fromRun(a, p)) continue; // rows from an earlier, abandoned run
    if (!a.started_at) continue;
    lesson.push(Math.max(0, Date.parse(a.started_at) - Date.parse(a.unlocked_at)));
    if (a.passed_at) {
      const lad = ladderFor(s.level);
      const min = lad[1] + lad[2] + lad[3] + lad[4];
      review.push((Date.parse(a.passed_at) - Date.parse(a.started_at)) / min);
    }
  }
  return {
    lessonLagMs: median(lesson) ?? 0,
    factor: Math.max(1, median(review) ?? 1),
    samples: { lesson: lesson.length, review: review.length },
  };
}

const byTime = (a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) || a.id - b.id;

/**
 * When the level can be passed.
 * `earliest`: lessons now, every review on time. `pace`: the same chain stretched by measured lags.
 * @returns {{needed:number, passed:number, remaining:number, reason:null|'vacation'|'passed'|'blocked',
 *            earliest:{at:Date|null, bottleneck:number[], lessonsNow:number, times:Map}, pace:{at:Date|null, bottleneck:number[]}, lags:object}}
 */
export function levelUpEta(items, ctx, lags = { lessonLagMs: 0, factor: 1, samples: { lesson: 0, review: 0 } }) {
  const { needed, passed } = items.kanji;
  const remaining = Math.max(0, needed - passed);
  const out = {
    needed, passed, remaining, reason: null, lags,
    earliest: { at: null, bottleneck: [], lessonsNow: 0, times: new Map() },
    pace: { at: null, bottleneck: [] },
  };
  if (ctx.user?.current_vacation_started_at) return { ...out, reason: 'vacation' };
  if (remaining === 0) return { ...out, reason: 'passed' };

  const pending = items.groups.kanji.filter((k) => !k.passed);
  const solve = (opts) => {
    const times = passTimes(pending, ctx, opts);
    const sorted = [...times.values()].sort(byTime);
    const at = sorted[remaining - 1]?.at ?? Infinity;
    if (!Number.isFinite(at)) return { at: null, bottleneck: [], lessonsNow: 0, times };
    return {
      at: new Date(at),
      bottleneck: sorted.filter((p) => p.at === at).map((p) => p.id),
      lessonsNow: sorted.slice(0, remaining).filter((p) => p.stage === 0).length,
      times,
    };
  };
  out.earliest = solve({ lessonLagMs: 0, factor: 1, floor: true });
  const pace = solve({ lessonLagMs: lags.lessonLagMs, factor: lags.factor, floor: false });
  out.pace = { at: pace.at, bottleneck: pace.bottleneck };
  if (!out.earliest.at) out.reason = 'blocked';
  return out;
}

/**
 * Cumulative kanji passed since the level was unlocked, for `level` and the level before it.
 * @returns {{threshold:number, series:{key:'current'|'previous', level:number, total:number, needed:number,
 *            unlockedAt:string, endX:number, points:{x:number, y:number, characters?:string}[]}[]}}
 */
export function levelTimeline(level, progressions, subjects, assignmentsById, now = new Date()) {
  const seriesFor = (lvl, key) => {
    const prog = progressionFor(progressions, lvl);
    if (!prog) return null;
    const kanji = subjects.filter((s) => s.object === 'kanji' && s.level === lvl && !s.hidden_at);
    const passes = [];
    for (const s of kanji) {
      const a = assignmentsById.get(s.id);
      if (!isUnlocked(a) || !fromRun(a, prog) || !a.passed_at || !isPassed(a, prog)) continue;
      passes.push({ x: Math.max(0, daysBetween(prog.unlocked_at, a.passed_at)), characters: s.characters ?? s.meaning });
    }
    passes.sort((a, b) => a.x - b.x);
    const points = [{ x: 0, y: 0 }, ...passes.map((p, i) => ({ x: p.x, y: i + 1, characters: p.characters }))];
    const end = Math.max(0, daysBetween(prog.unlocked_at, prog.passed_at ?? new Date(now).toISOString()));
    return {
      key, level: lvl, total: kanji.length, needed: neededKanji(kanji.length), unlockedAt: prog.unlocked_at,
      endX: Math.max(end, points.at(-1).x), points,
    };
  };
  const current = seriesFor(level, 'current');
  if (!current) return { threshold: 0, series: [] };
  const previous = level > 1 ? seriesFor(level - 1, 'previous') : null;
  return { threshold: current.needed, series: previous ? [current, previous] : [current] };
}
