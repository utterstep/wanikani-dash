// Pure diff logic: snapshot(prev) vs fresh(next) → events.
// No DOM, no IndexedDB — unit-tested in tests/diff.test.js.

/**
 * Slim a raw WK assignment resource into what we store.
 * @param {object} r  raw API resource ({id, data:{...}, data_updated_at})
 */
export function slimAssignment(r) {
  const d = r.data;
  return {
    subject_id: d.subject_id,
    subject_type: d.subject_type,
    srs_stage: d.srs_stage,
    unlocked_at: d.unlocked_at,
    started_at: d.started_at,
    passed_at: d.passed_at,
    burned_at: d.burned_at,
    available_at: d.available_at,
    hidden: d.hidden,
    data_updated_at: r.data_updated_at,
  };
}

export function slimStat(r) {
  const d = r.data;
  return {
    subject_id: d.subject_id,
    subject_type: d.subject_type,
    meaning_correct: d.meaning_correct,
    meaning_incorrect: d.meaning_incorrect,
    reading_correct: d.reading_correct,
    reading_incorrect: d.reading_incorrect,
    meaning_current_streak: d.meaning_current_streak,
    reading_current_streak: d.reading_current_streak,
    meaning_max_streak: d.meaning_max_streak,
    reading_max_streak: d.reading_max_streak,
    percentage_correct: d.percentage_correct,
    hidden: d.hidden,
    data_updated_at: r.data_updated_at,
  };
}

export function slimSubject(r) {
  const d = r.data;
  const primaryMeaning = (d.meanings || []).find((m) => m.primary) || d.meanings?.[0];
  const primaryReading = (d.readings || []).find((m) => m.primary) || d.readings?.[0];
  return {
    id: r.id,
    object: r.object, // radical | kanji | vocabulary | kana_vocabulary
    level: d.level,
    characters: d.characters,
    slug: d.slug,
    meaning: primaryMeaning?.meaning ?? null,
    reading: primaryReading?.reading ?? null,
    document_url: d.document_url,
    hidden_at: d.hidden_at,
  };
}

export function slimProgression(r) {
  const d = r.data;
  return {
    id: r.id,
    level: d.level,
    unlocked_at: d.unlocked_at,
    started_at: d.started_at,
    passed_at: d.passed_at,
    completed_at: d.completed_at,
    abandoned_at: d.abandoned_at,
  };
}

/**
 * Compare changed assignments against previously stored ones.
 * @param {Map<number, object>} prevById  subject_id → stored slim assignment
 * @param {object[]} next                 slim assignments fetched this sync
 * @param {string} seenAt                 ISO timestamp of this sync
 * @returns {{events: object[]}}  srs_events: {subject_id, subject_type, from, to, at, seen_at}
 */
export function diffAssignments(prevById, next, seenAt) {
  const events = [];
  for (const a of next) {
    const p = prevById.get(a.subject_id);
    if (!p) continue; // first sight — no history to compare against
    if (p.srs_stage === a.srs_stage) continue;
    events.push({
      subject_id: a.subject_id,
      subject_type: a.subject_type,
      from: p.srs_stage,
      to: a.srs_stage,
      at: a.data_updated_at || seenAt,
      seen_at: seenAt,
    });
  }
  return { events };
}

/**
 * Sum review-counter deltas across changed review_statistics.
 * A "review" on WK = one item answered (meaning + reading where applicable).
 * Reviews per item ≈ max(meaning answers delta, reading answers delta).
 * @param {Map<number, object>} prevById
 * @param {object[]} next  slim stats fetched this sync
 * @param {string} at      ISO timestamp of this sync
 * @returns {object|null}  review_event or null if nothing changed
 */
export function diffStats(prevById, next, at) {
  const ev = {
    at,
    reviews: 0,
    items: 0,
    meaning_correct_d: 0,
    meaning_incorrect_d: 0,
    reading_correct_d: 0,
    reading_incorrect_d: 0,
  };
  for (const s of next) {
    const p = prevById.get(s.subject_id);
    if (!p) continue;
    const mc = s.meaning_correct - p.meaning_correct;
    const mi = s.meaning_incorrect - p.meaning_incorrect;
    const rc = s.reading_correct - p.reading_correct;
    const ri = s.reading_incorrect - p.reading_incorrect;
    const m = Math.max(0, mc + mi);
    const readable = s.subject_type === 'kanji' || s.subject_type === 'vocabulary';
    const r = readable ? Math.max(0, rc + ri) : 0;
    const n = Math.max(m, r);
    if (n === 0) continue;
    ev.reviews += n;
    ev.items += 1;
    ev.meaning_correct_d += Math.max(0, mc);
    ev.meaning_incorrect_d += Math.max(0, mi);
    if (readable) { ev.reading_correct_d += Math.max(0, rc); ev.reading_incorrect_d += Math.max(0, ri); }
  }
  return ev.reviews > 0 ? ev : null;
}
