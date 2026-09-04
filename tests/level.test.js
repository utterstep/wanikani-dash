import { describe, it, assert, assertEqual, assertClose } from './harness.js';
import {
  HOUR, LADDERS, ladderFor, floorHour, neededKanji, progressionFor, isPassed, levelItems, afterStage,
  passTimes, measureLags, levelUpEta, levelTimeline,
} from '../public/js/level.js';
import { slimProgression } from '../public/js/diff.js';
import { fixtures, levelFixture, NOW_A } from './fixtures/synthetic.js';

const F = levelFixture();
const NOW = new Date(NOW_A + 20 * 60_000); // 10:20Z
const iso = (ms) => new Date(ms).toISOString();
const ctxFor = (level, over = {}) => {
  const progression = progressionFor(F.progressions, level);
  const items = levelItems(level, F.subjects, F.assignmentsById, NOW, progression);
  const ctx = { subjectsById: F.subjectsById, assignmentsById: F.assignmentsById, user: F.user, now: NOW, progression, ...over };
  return { items, ctx, progression };
};

describe('level: rules', () => {
  it('needs 90% of the kanji, rounded up, without float slop', () => {
    assertEqual([0, 10, 32, 35, 70].map(neededKanji), [0, 9, 29, 32, 63]);
  });
  it('uses the accelerated ladder on levels 1–2 only', () => {
    assertEqual(ladderFor(1), LADDERS.accelerated); assertEqual(ladderFor(2), LADDERS.accelerated); assertEqual(ladderFor(3), LADDERS.default);
  });
  it('floors to the hour', () => { assertEqual(iso(floorHour(+NOW)), '2026-08-20T10:00:00.000Z'); });
  it('chains lesson → Guru with WaniKani hour rounding', () => {
    // lesson at 10:20 → 14:00 → 22:00 → 21:00 (+1 d) → 20:00 (+3 d)
    assertEqual(iso(afterStage(+NOW, 1, LADDERS.default)), '2026-08-23T20:00:00.000Z');
    assertEqual(afterStage(+NOW, 1, LADDERS.accelerated, { floor: false }) - +NOW, 37 * HOUR);
    assertEqual(afterStage(+NOW, 1, LADDERS.default, { floor: false, factor: 2 }) - +NOW, 2 * 82 * HOUR);
    assertEqual(afterStage(+NOW, 5, LADDERS.default), +NOW);
  });
  it('picks the live run of a level', () => {
    assertEqual(progressionFor(F.progressions, 4).id, 5);
    assertEqual(progressionFor(fixtures('a').level_progressions.map(slimProgression), 3).id, 303);
    assertEqual(progressionFor(F.progressions, 9), null);
  });
  it('counts passed_at only from the current run', () => {
    const prog = progressionFor(F.progressions, 4);
    assert(isPassed(F.assignmentsById.get(26), prog), 'demoted Guru still passed');
    assert(!isPassed(F.assignmentsById.get(27), prog), 'pass from before the reset');
    assert(isPassed(F.assignmentsById.get(27), null), 'without a run any passed_at counts');
  });
});

describe('level: items', () => {
  const { items } = ctxFor(4);
  it('groups the level by type, folding kana vocabulary and skipping hidden subjects', () => {
    assertEqual(Object.fromEntries(Object.entries(items.groups).map(([k, v]) => [k, v.length])), { radical: 2, kanji: 8, vocabulary: 2 });
    assert(!items.groups.kanji.some((k) => k.id === 28));
  });
  it('derives state, passed and dueNow', () => {
    const k = Object.fromEntries(items.groups.kanji.map((i) => [i.id, i]));
    assertEqual(items.counts.kanji.locked, 2);
    assertEqual(items.groups.kanji.filter((i) => i.dueNow).map((i) => i.id), [21]);
    assertEqual([k[26].state, k[26].passed], ['apprentice', true]);
    assertEqual([k[27].state, k[27].passed], ['lesson', false]);
    assertEqual([k[23].state, k[24].state, k[23].srs_stage], ['locked', 'locked', null]);
    assertEqual(items.kanji, { passed: 2, total: 8, needed: 8 });
    assertEqual(items.radicals, { passed: 1, total: 2 });
    assertEqual(items.groups.radical.find((r) => r.id === 10).image, 'https://cdn.wanikani.com/images/legacy/gun.svg');
  });
  it('sorts most learned first', () => {
    assertEqual(items.groups.kanji.map((i) => i.id), [25, 22, 21, 26, 20, 27, 23, 24]);
  });
});

describe('level: ETA', () => {
  const { items, ctx } = ctxFor(4);
  it('computes each kanji\'s earliest pass time through its radicals', () => {
    const t = passTimes(items.groups.kanji.filter((k) => !k.passed), ctx);
    assertEqual(iso(t.get(22).at), '2026-08-20T15:00:00.000Z');       // stage 4, review at available_at
    assertEqual(iso(t.get(21).at), '2026-08-22T09:00:00.000Z');       // due now → stage 4 → +47 h floored
    assertEqual(iso(t.get(20).at), '2026-08-23T20:00:00.000Z');       // lesson now
    assertEqual(iso(t.get(27).at), '2026-08-23T20:00:00.000Z');
    assertEqual([iso(t.get(24).unlockAt), iso(t.get(24).at), t.get(24).gateRadical], [NOW.toISOString(), '2026-08-23T20:00:00.000Z', null]);
    assertEqual([iso(t.get(23).unlockAt), t.get(23).gateRadical, iso(t.get(23).at)], ['2026-08-20T13:00:00.000Z', 10, '2026-08-23T23:00:00.000Z']);
  });
  it('dates the level-up by the k-th fastest kanji and names the bottleneck', () => {
    const eta = levelUpEta(items, ctx, measureLags(F.subjects, F.assignmentsById, F.progressions));
    assertEqual([eta.needed, eta.passed, eta.remaining, eta.reason], [8, 2, 6, null]);
    assertEqual(eta.earliest.at.toISOString(), '2026-08-23T23:00:00.000Z');
    assertEqual(eta.earliest.bottleneck, [23]);
    assertEqual(eta.earliest.lessonsNow, 2);
    assert(eta.pace.at > eta.earliest.at, 'pace is later than earliest');
    // pace: 23 unlocks at 13:00, lesson 6 h later, 82 h × 1.5 without flooring
    assertEqual(eta.pace.at.toISOString(), iso(NOW_A + 3 * HOUR + 6 * HOUR + 123 * HOUR));
  });
  it('stops for vacation, a passed level and locked radicals', () => {
    const lags = { lessonLagMs: 0, factor: 1, samples: { lesson: 0, review: 0 } };
    assertEqual(levelUpEta(items, { ...ctx, user: { ...F.user, current_vacation_started_at: '2026-08-01T00:00:00.000Z' } }, lags).reason, 'vacation');
    const l2 = ctxFor(2);
    assertEqual(levelUpEta(l2.items, l2.ctx, lags).reason, 'passed');
    const asgs = new Map(F.assignmentsById);
    asgs.set(10, { ...asgs.get(10), unlocked_at: null });
    const blocked = levelUpEta(items, { ...ctx, assignmentsById: asgs }, lags);
    assertEqual([blocked.reason, blocked.earliest.at, blocked.pace.at], ['blocked', null, null]);
  });
});

describe('level: lags and timeline', () => {
  it('measures lesson lag and review factor on the last completed levels', () => {
    const lags = measureLags(F.subjects, F.assignmentsById, F.progressions);
    assertEqual(lags.lessonLagMs, 6 * HOUR);
    assertClose(lags.factor, 1.5);
    assertEqual(lags.samples, { lesson: 3, review: 3 }); // 43 predates the level-3 run
    assertEqual(measureLags(F.subjects, F.assignmentsById, []), { lessonLagMs: 0, factor: 1, samples: { lesson: 0, review: 0 } });
  });
  it('builds the cumulative kanji-passed staircase with the previous level', () => {
    const tl = levelTimeline(4, F.progressions, F.subjects, F.assignmentsById, NOW);
    assertEqual(tl.threshold, 8);
    assertEqual(tl.series.map((s) => [s.key, s.level]), [['current', 4], ['previous', 3]]);
    const cur = tl.series[0];
    assertEqual(cur.points.map((p) => [p.x, p.y]), [[0, 0], [2, 1], [3, 2]]);
    assertClose(cur.endX, 5 + 20 / 1440);
    const prev = tl.series[1];
    assertEqual(prev.points.length, 2); // 42 only; 43 is from before the run
    assertClose(prev.points[1].x, (8 + 164) / 24);
    assertEqual(prev.endX, 14);
    assertEqual(levelTimeline(9, F.progressions, F.subjects, F.assignmentsById, NOW), { threshold: 0, series: [] });
  });
});
