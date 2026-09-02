// Server state ↔ IndexedDB. The server is the source of truth for the snapshot and history;
// IndexedDB is a cache so the page renders instantly and works offline.

const byKey = (rows, k) => new Map(rows.map((r) => [r[k], r]));

/** Merge a /api/state response into the local DB. Idempotent (event rows keyed by server id). */
export async function applyState(db, s) {
  const a = s.account;
  if (a.status === 'empty') return;
  if (s.since === 0) for (const st of ['assignments', 'review_statistics', 'level_progressions', 'srs_events', 'review_events', 'syncs']) await db.clear(st);
  await db.putAll('assignments', s.assignments);
  await db.putAll('review_statistics', s.review_statistics);
  await db.putAll('level_progressions', s.level_progressions);
  await db.putAllKeyed('srs_events', s.srs_events, (r) => r.id);
  await db.putAllKeyed('review_events', s.review_events, (r) => r.id);
  await db.putAllKeyed('syncs', s.syncs, (r) => r.id);
  if (a.user) await db.setMeta('user', a.user);
  await db.setMeta('history_since', a.history_since);
  await db.setMeta('last_sync', a.last_sync);
  await db.setMeta('status', a.status);
  await db.setMeta('server_version', a.version);
}

/** True when this browser collected history itself (pre-server era) and has never pulled from the server. */
export async function hasLocalHistory(db) {
  if ((await db.getMeta('server_version')) !== undefined) return false;
  if (!(await db.getMeta('history_since'))) return false;
  return (await db.count('assignments')) > 0;
}

/** Everything the server needs to adopt this browser's history. */
export async function collectSeed(db) {
  const [assignments, stats, progressions, srs_events, review_events, syncs] = await Promise.all([
    db.getAll('assignments'), db.getAll('review_statistics'), db.getAll('level_progressions'),
    db.getAll('srs_events'), db.getAll('review_events'), db.getAll('syncs'),
  ]);
  const cursors = (await db.getMeta('cursors')) ?? {};
  return {
    history_since: await db.getMeta('history_since'),
    last_sync: await db.getMeta('last_sync'),
    cursors: { assignments: cursors.assignments, review_statistics: cursors.review_statistics },
    assignments, stats, progressions, srs_events, review_events, syncs,
  };
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
    status: await db.getMeta('status'),
    subjects, assignments, stats, progressions, srsEvents, reviewEvents,
    syncDates: syncs.map((s) => s.at),
    subjectsById: byKey(subjects, 'id'),
    assignmentsById: byKey(assignments, 'subject_id'),
  };
}
