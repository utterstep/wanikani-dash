// Synthetic WK API fixtures in raw resource shape. Deterministic.
// scenario 'a' = baseline snapshot; 'b' = a few days later, after some reviews.

const ISO = (d) => new Date(d).toISOString();
const DAY = 86_400_000;
export const NOW_A = Date.parse('2026-08-20T10:00:00Z');
export const NOW_B = Date.parse('2026-08-22T09:00:00Z');

const SUBJECTS = [
  { id: 1, object: 'radical', level: 1, characters: '一', slug: 'ground', meanings: [{ meaning: 'Ground', primary: true }] },
  { id: 2, object: 'kanji', level: 1, characters: '一', slug: '一', meanings: [{ meaning: 'One', primary: true }], readings: [{ reading: 'いち', primary: true }] },
  { id: 3, object: 'kanji', level: 2, characters: '人', slug: '人', meanings: [{ meaning: 'Person', primary: true }], readings: [{ reading: 'にん', primary: true }] },
  { id: 4, object: 'vocabulary', level: 2, characters: '人', slug: '人', meanings: [{ meaning: 'Person', primary: true }], readings: [{ reading: 'ひと', primary: true }] },
  { id: 5, object: 'vocabulary', level: 3, characters: '大人', slug: '大人', meanings: [{ meaning: 'Adult', primary: true }], readings: [{ reading: 'おとな', primary: true }] },
  { id: 6, object: 'kanji', level: 3, characters: '日', slug: '日', meanings: [{ meaning: 'Sun', primary: true }], readings: [{ reading: 'にち', primary: true }] },
  { id: 7, object: 'kana_vocabulary', level: 3, characters: 'こんにちは', slug: 'こんにちは', meanings: [{ meaning: 'Hello', primary: true }] },
  { id: 8, object: 'kanji', level: 4, characters: '月', slug: '月', meanings: [{ meaning: 'Moon', primary: true }], readings: [{ reading: 'げつ', primary: true }] },
];

// [subject_id, srs_stage_a, srs_stage_b, available_at offset days from now (b)]
const ASSIGN = [
  [1, 9, 9, null], [2, 8, 8, 20], [3, 5, 6, 3], [4, 4, 3, 0.5], [5, 2, 3, 1], [6, 1, 1, -1], [7, 0, 1, 1], [8, 3, 3, 2],
];
// [subject_id, mc, mi, rc, ri, mstreak, rstreak] for a; b adds deltas
const STATS_A = [
  [1, 20, 0, 0, 0, 20, 0], [2, 18, 1, 17, 2, 10, 8], [3, 9, 4, 8, 5, 1, 2], [4, 6, 7, 5, 8, 1, 0], [5, 3, 1, 2, 2, 2, 1], [6, 1, 3, 1, 3, 0, 0], [8, 4, 2, 4, 2, 3, 3],
];
const STATS_B_DELTA = { 3: [1, 0, 1, 0], 4: [0, 1, 0, 1], 5: [1, 0, 1, 0], 7: [1, 0, 0, 0] };

const PROGRESSIONS = [
  { level: 1, unlocked: -40, passed: -33 },
  { level: 2, unlocked: -33, passed: -26 },
  { level: 3, unlocked: -26, passed: -12, abandoned: true },
  { level: 3, unlocked: -12, passed: -5 },
  { level: 4, unlocked: -5, passed: null },
];

export function fixtures(scenario = 'a') {
  const now = scenario === 'b' ? NOW_B : NOW_A;
  const user = { object: 'user', data_updated_at: ISO(now), data: { id: '5a6a5234-a392-4a87-8f3f-33342afe8a42', username: 'testuser', level: 4, started_at: ISO(NOW_A - 40 * DAY), current_vacation_started_at: null, subscription: { active: true, type: 'lifetime', max_level_granted: 60 } } };

  const subjects = SUBJECTS.map((s) => ({ id: s.id, object: s.object, data_updated_at: ISO(NOW_A - 100 * DAY), data: { ...s, document_url: `https://www.wanikani.com/${s.object}/${s.slug}`, hidden_at: null, readings: s.readings ?? [] } }));

  const assignments = ASSIGN.map(([id, sa, sb, off], i) => {
    const stage = scenario === 'b' ? sb : sa;
    const changed = scenario === 'b' && sa !== sb;
    const sub = SUBJECTS.find((s) => s.id === id);
    return {
      id: 100 + i, object: 'assignment',
      data_updated_at: ISO(changed ? NOW_B - 20 * 3600_000 : NOW_A - 2 * DAY), // changes happen "yesterday" relative to b
      data: {
        subject_id: id, subject_type: sub.object, srs_stage: stage,
        unlocked_at: ISO(NOW_A - 30 * DAY), started_at: stage ? ISO(NOW_A - 29 * DAY) : null,
        passed_at: stage >= 5 ? ISO(NOW_A - 10 * DAY) : null, burned_at: stage === 9 ? ISO(NOW_A - DAY) : null,
        available_at: off == null ? null : ISO(NOW_B + off * DAY), hidden: false,
      },
    };
  });

  const statsRows = STATS_A.map((r) => [...r]);
  if (scenario === 'b') {
    statsRows.push([7, 0, 0, 0, 0, 0, 0]);
    for (const r of statsRows) {
      const d = STATS_B_DELTA[r[0]];
      if (!d) continue;
      r[1] += d[0]; r[2] += d[1]; r[3] += d[2]; r[4] += d[3];
      r[5] = d[1] ? 0 : r[5] + 1; r[6] = d[3] ? 0 : r[6] + (d[2] ? 1 : 0);
    }
  }
  const review_statistics = statsRows.map(([id, mc, mi, rc, ri, ms, rs], i) => {
    const sub = SUBJECTS.find((s) => s.id === id);
    const changed = scenario === 'b' && (STATS_B_DELTA[id] || id === 7);
    return {
      id: 200 + i, object: 'review_statistic', data_updated_at: ISO(changed ? NOW_B - 20 * 3600_000 : NOW_A - 2 * DAY),
      data: { subject_id: id, subject_type: sub.object, meaning_correct: mc, meaning_incorrect: mi, reading_correct: rc, reading_incorrect: ri, meaning_current_streak: ms, reading_current_streak: rs, meaning_max_streak: ms, reading_max_streak: rs, percentage_correct: Math.round(((mc + rc) / Math.max(1, mc + mi + rc + ri)) * 100), hidden: false },
    };
  });

  const level_progressions = PROGRESSIONS.map((p, i) => ({
    id: 300 + i, object: 'level_progression', data_updated_at: ISO(NOW_A),
    data: { level: p.level, unlocked_at: ISO(NOW_A + p.unlocked * DAY), started_at: ISO(NOW_A + p.unlocked * DAY), passed_at: p.passed != null && !p.abandoned ? ISO(NOW_A + p.passed * DAY) : null, completed_at: null, abandoned_at: p.abandoned ? ISO(NOW_A + p.passed * DAY) : null },
  }));

  const summary = { object: 'report', data_updated_at: ISO(now), data: {
    lessons: [{ available_at: ISO(now), subject_ids: scenario === 'b' ? [8, 9] : [] }],
    next_reviews_at: ISO(now + 3600e3),
    reviews: [{ available_at: ISO(now - 3600e3), subject_ids: scenario === 'b' ? [6, 4, 5] : [] }, { available_at: ISO(now + 3600e3), subject_ids: [3] }],
  } };

  return { user, summary, subjects, assignments, review_statistics, level_progressions };
}
