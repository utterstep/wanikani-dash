import { describe, it, assertEqual, assertClose, assert } from './harness.js';
import { levelDurations, projection, srsDistribution, accuracyByType, leeches, leechScore, dailySeries, upcomingReviews, median, dateKey } from '../js/stats.js';
import { slimAssignment, slimStat, slimSubject, slimProgression } from '../js/diff.js';
import { fixtures, NOW_A, NOW_B } from './fixtures/synthetic.js';

const fa = fixtures('a');
const progs = fa.level_progressions.map(slimProgression);
const asg = fa.assignments.map(slimAssignment);
const stats = fa.review_statistics.map(slimStat);
const subs = fa.subjects.map(slimSubject);
const nowA = new Date(NOW_A);

describe('levelDurations', () => {
  it('computes days per level incl. current and abandoned', () => {
    const rows = levelDurations(progs, nowA);
    assertEqual(rows.map((r) => r.level), [1, 2, 3, 3, 4]);
    assertClose(rows[0].days, 7);
    assert(rows[2].abandoned && !rows[3].abandoned);
    assertClose(rows[2].days, 14);
    assert(rows[4].current); assertClose(rows[4].days, 5);
  });
});

describe('projection', () => {
  it('uses median of completed levels, ignoring abandoned/current', () => {
    const p = projection(progs, 4, nowA);
    assertEqual(p.pace, 7); // completed: 7, 7, 7
    assertClose(p.daysOnCurrent, 5);
    assertClose(p.nextLevelIn, 2);
    assertEqual(p.levelsLeft, 56);
    assertEqual(p.nextLevelAt.toISOString(), new Date(NOW_A + 2 * 86400000).toISOString());
    assertClose((p.level60At - nowA) / 86400000, 2 + 55 * 7);
  });
  it('returns nulls with no completed levels', () => {
    const p = projection([{ level: 1, unlocked_at: nowA.toISOString() }], 1, nowA);
    assertEqual(p.pace, null); assertEqual(p.nextLevelAt, null);
  });
  it('median', () => { assertEqual(median([3, 1, 2]), 2); assertEqual(median([4, 1, 2, 3]), 2.5); assertEqual(median([]), null); });
});

describe('srsDistribution', () => {
  it('groups by stage and folds kana_vocabulary into vocabulary', () => {
    const d = srsDistribution(asg);
    assertEqual(d.total, { apprentice: 4, guru: 1, master: 0, enlightened: 1, burned: 1 }); // stage 0 excluded
    assertEqual(d.byType.vocabulary.apprentice, 2);
    assertEqual(d.byType.kanji.enlightened, 1);
    assertEqual(d.byType.radical.burned, 1);
  });
});

describe('accuracyByType', () => {
  it('computes meaning/reading accuracy per type', () => {
    const a = accuracyByType(stats);
    assertEqual(a.radical.meaning, 1); assertEqual(a.radical.reading, null);
    assertClose(a.kanji.meaning, (18 + 9 + 1 + 4) / (18 + 1 + 9 + 4 + 1 + 3 + 4 + 2));
    assert(a.vocabulary.answers > 0);
  });
});

describe('leeches', () => {
  it('scores incorrect / streak^1.5', () => {
    assertEqual(leechScore(0, 5), 0);
    assertEqual(leechScore(4, 1), 4);
    assertClose(leechScore(8, 4), 1);
  });
  it('ranks leeches, excludes burned and locked', () => {
    const rows = leeches(stats, new Map(asg.map((a) => [a.subject_id, a])), new Map(subs.map((s) => [s.id, s])));
    assert(!rows.some((r) => r.subject_id === 1), 'burned excluded');
    assertEqual(rows[0].subject_id, 4); // 8 wrong / streak 0 → 8
    assertEqual(rows[0].worst, 'reading');
    assert(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), 'sorted desc');
    assertEqual(rows[0].type, 'vocabulary');
    assert(rows[0].url.startsWith('https://'));
  });
});

describe('dailySeries', () => {
  it('buckets events by local day, marks sync days', () => {
    const now = new Date(NOW_B);
    const srs = [
      { from: 5, to: 6, at: new Date(NOW_B - 3600e3).toISOString() },
      { from: 4, to: 3, at: new Date(NOW_B - 3600e3).toISOString() },
      { from: 1, to: 2, at: new Date(NOW_B - 30 * 86400e3).toISOString() }, // out of window
    ];
    const rev = [{ at: new Date(NOW_B - 3600e3).toISOString(), reviews: 12 }];
    const s = dailySeries(srs, rev, [now.toISOString()], 7, now);
    assertEqual(s.length, 7);
    const last = s[6];
    assertEqual(last.date, dateKey(now.toISOString()));
    assertEqual(last.reviews, 12);
    assertEqual(last.upTotal, 1); assertEqual(last.downTotal, 1);
    assertEqual(last.ups.guru, 1); assertEqual(last.downs.apprentice, 1);
    assert(last.synced && !s[0].synced);
  });
});

describe('upcomingReviews', () => {
  it('counts overdue and per-day upcoming, skipping burned/locked', () => {
    const u = upcomingReviews(asg, 7, new Date(NOW_B));
    assertEqual(u.overdue, 1); // subject 6 at -1 day
    assertEqual(u.days.length, 7);
    assertEqual(u.days.reduce((a, d) => a + d.count, 0), 4); // 3,4,5,8 within 7 days; 2 is at +20; 7 locked
  });
});
