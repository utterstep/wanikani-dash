// Fetch from WK → diff against stored snapshot → persist events + new snapshot.

import { slimAssignment, slimStat, slimSubject, slimProgression, diffAssignments, diffStats } from './diff.js';

const byKey = (rows, k) => new Map(rows.map((r) => [r[k], r]));

/**
 * @param {import('./api.js').WkApi} api
 * @param {import('./db.js').Db} db
 * @param {{now?: Date}} opts
 * @returns {Promise<{firstRun:boolean, srsEvents:number, reviews:number}>}
 */
export async function sync(api, db, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const cursors = (await db.getMeta('cursors')) ?? {};
  const firstRun = !(await db.getMeta('last_sync'));

  // 1. user (level, vacation)
  const user = await api.getOne('/user');
  await db.setMeta('user', {
    username: user.data.username,
    level: user.data.level,
    started_at: user.data.started_at,
    current_vacation_started_at: user.data.current_vacation_started_at,
    subscription: user.data.subscription,
  });

  // 1b. summary (lessons / reviews available right now)
  try {
    const summary = await api.getOne('/summary');
    const avail = (summary.data.reviews ?? []).filter((r) => r.available_at <= nowIso).reduce((n, r) => n + r.subject_ids.length, 0);
    await db.setMeta('summary', {
      lessons: (summary.data.lessons ?? []).reduce((n, l) => n + l.subject_ids.length, 0),
      reviews: avail,
      next_reviews_at: summary.data.next_reviews_at,
      at: nowIso,
    });
  } catch (e) {
    if (e.name === 'AuthError') await db.setMeta('summary', null); // token lacks summary scope — fine
    else throw e;
  }

  // 2. subjects (big, cached permanently; incremental after first run)
  const subjParams = cursors.subjects ? { updated_after: cursors.subjects } : {};
  const subjects = await api.getAll('/subjects', subjParams);
  if (subjects.length) await db.putAll('subjects', subjects.map(slimSubject));

  // 3. level progressions (small: refetch all)
  const progressions = await api.getAll('/level_progressions');
  await db.putAll('level_progressions', progressions.map(slimProgression));

  // 4. assignments + review statistics (incremental)
  const asgParams = cursors.assignments ? { updated_after: cursors.assignments } : {};
  const statParams = cursors.review_statistics ? { updated_after: cursors.review_statistics } : {};
  const [asgRaw, statRaw] = await Promise.all([
    api.getAll('/assignments', asgParams),
    api.getAll('/review_statistics', statParams),
  ]);
  const asg = asgRaw.map(slimAssignment);
  const stats = statRaw.map(slimStat);

  // 5–6. diff against stored rows
  const prevAsg = byKey((await db.getMany('assignments', asg.map((a) => a.subject_id))).filter(Boolean), 'subject_id');
  const prevStats = byKey((await db.getMany('review_statistics', stats.map((s) => s.subject_id))).filter(Boolean), 'subject_id');
  const { events } = diffAssignments(prevAsg, asg, nowIso);
  const reviewEvent = diffStats(prevStats, stats, nowIso);

  // 7. persist: events first, then snapshot, then cursors (so a crash never loses events)
  await db.addAll('srs_events', events);
  if (reviewEvent) await db.addAll('review_events', [reviewEvent]);
  await db.putAll('assignments', asg);
  await db.putAll('review_statistics', stats);
  await db.addAll('syncs', [{ at: nowIso, srs_events: events.length, reviews: reviewEvent?.reviews ?? 0 }]);

  // Cursor = max data_updated_at seen (safer than "now" against clock skew). Keep the old cursor if nothing came back.
  const maxUpd = (rows, prev) => rows.reduce((m, r) => (r.data_updated_at > m ? r.data_updated_at : m), prev ?? '');
  await db.setMeta('cursors', {
    subjects: maxUpd(subjects, cursors.subjects) || nowIso,
    assignments: maxUpd(asgRaw, cursors.assignments) || nowIso,
    review_statistics: maxUpd(statRaw, cursors.review_statistics) || nowIso,
  });
  if (firstRun) await db.setMeta('history_since', nowIso);
  await db.setMeta('last_sync', nowIso);

  return { firstRun, srsEvents: events.length, reviews: reviewEvent?.reviews ?? 0 };
}

/** Everything the renderer needs, loaded from the DB. */
export async function loadModel(db) {
  const [subjects, assignments, stats, progressions, srsEvents, reviewEvents, syncs] = await Promise.all([
    db.getAll('subjects'), db.getAll('assignments'), db.getAll('review_statistics'),
    db.getAll('level_progressions'), db.getAll('srs_events'), db.getAll('review_events'), db.getAll('syncs'),
  ]);
  return {
    user: await db.getMeta('user'),
    summary: await db.getMeta('summary'),
    lastSync: await db.getMeta('last_sync'),
    historySince: await db.getMeta('history_since'),
    subjects, assignments, stats, progressions, srsEvents, reviewEvents,
    syncDates: syncs.map((s) => s.at),
    subjectsById: byKey(subjects, 'id'),
    assignmentsById: byKey(assignments, 'subject_id'),
  };
}
