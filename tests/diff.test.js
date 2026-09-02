import { describe, it, assertEqual, assert } from './harness.js';
import { diffAssignments, diffStats, slimAssignment, slimStat, slimSubject } from '../public/js/diff.js';
import { fixtures } from './fixtures/synthetic.js';

const byId = (rows) => new Map(rows.map((r) => [r.subject_id, r]));

describe('diffAssignments', () => {
  it('emits one event per stage change with the assignment timestamp', () => {
    const a = fixtures('a').assignments.map(slimAssignment);
    const b = fixtures('b').assignments.map(slimAssignment);
    const { events } = diffAssignments(byId(a), b, '2026-08-22T09:00:00.000Z');
    const byS = Object.fromEntries(events.map((e) => [e.subject_id, e]));
    assertEqual(events.length, 4);
    assertEqual(byS[3].from, 5); assertEqual(byS[3].to, 6);
    assertEqual(byS[4].from, 4); assertEqual(byS[4].to, 3);
    assertEqual(byS[7].from, 0); assertEqual(byS[7].to, 1);
    assertEqual(byS[3].at, b.find((x) => x.subject_id === 3).data_updated_at);
    assertEqual(byS[3].seen_at, '2026-08-22T09:00:00.000Z');
  });
  it('ignores never-seen assignments', () => {
    const b = fixtures('b').assignments.map(slimAssignment);
    assertEqual(diffAssignments(new Map(), b, 'x').events, []);
  });
  it('falls back to seen_at when data_updated_at is missing', () => {
    const prev = byId([{ subject_id: 1, srs_stage: 1 }]);
    const { events } = diffAssignments(prev, [{ subject_id: 1, srs_stage: 2 }], 'NOW');
    assertEqual(events[0].at, 'NOW');
  });
});

describe('diffStats', () => {
  it('counts reviews as max(meaning, reading) answers per item', () => {
    const a = fixtures('a').review_statistics.map(slimStat);
    const b = fixtures('b').review_statistics.map(slimStat);
    const ev = diffStats(byId(a), b, 'T');
    // items 3,4,5 changed (1 review each); item 7 is new → ignored
    assertEqual(ev.reviews, 3);
    assertEqual(ev.items, 3);
    assertEqual(ev.meaning_correct_d, 2);
    assertEqual(ev.meaning_incorrect_d, 1);
    assertEqual(ev.reading_incorrect_d, 1);
    assertEqual(ev.at, 'T');
  });
  it('returns null when nothing changed', () => {
    const a = fixtures('a').review_statistics.map(slimStat);
    assertEqual(diffStats(byId(a), a, 'T'), null);
  });
  it('handles radicals (meaning only)', () => {
    const prev = byId([{ subject_id: 1, meaning_correct: 1, meaning_incorrect: 0, reading_correct: 0, reading_incorrect: 0 }]);
    const ev = diffStats(prev, [{ subject_id: 1, meaning_correct: 3, meaning_incorrect: 1, reading_correct: 0, reading_incorrect: 0 }], 'T');
    assertEqual(ev.reviews, 3);
  });
});

describe('slim*', () => {
  it('slimSubject picks primary meaning/reading', () => {
    const s = slimSubject({ id: 9, object: 'kanji', data: { level: 1, characters: '人', slug: '人', meanings: [{ meaning: 'X', primary: false }, { meaning: 'Person', primary: true }], readings: [{ reading: 'ひと', primary: false }, { reading: 'にん', primary: true }], document_url: 'u', hidden_at: null } });
    assertEqual(s.meaning, 'Person'); assertEqual(s.reading, 'にん'); assertEqual(s.id, 9);
  });
  it('slimAssignment keeps data_updated_at', () => {
    const a = slimAssignment(fixtures('a').assignments[0]);
    assert(a.data_updated_at); assertEqual(a.subject_id, 1);
  });
});

describe('diffStats radicals', () => {
  it('counts only meaning answers for radicals', () => {
    const prev = byId([{ subject_id: 1, subject_type: 'radical', meaning_correct: 1, meaning_incorrect: 0, reading_correct: 1, reading_incorrect: 0 }]);
    const ev = diffStats(prev, [{ subject_id: 1, subject_type: 'radical', meaning_correct: 2, meaning_incorrect: 0, reading_correct: 2, reading_incorrect: 0 }], 'T');
    assertEqual(ev.reviews, 1); assertEqual(ev.reading_correct_d, 0);
  });
});
