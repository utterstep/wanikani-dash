import { describe, it, assertEqual, assert } from './harness.js';
import { openDb, deleteDb } from '../public/js/db.js';
import { applyState, hasLocalHistory, collectSeed, loadModel } from '../public/js/pull.js';

const DBN = 'wkdash-test-pull';
const user = { id: 'u-1', username: 'testuser', level: 4 };
const state = (since, version, extra = {}) => ({
  since,
  account: { status: 'active', user, history_since: '2026-08-01T00:00:00Z', last_sync: '2026-08-22T09:00:00Z', version },
  assignments: [], review_statistics: [], level_progressions: [], srs_events: [], review_events: [], syncs: [],
  ...extra,
});

describe('pull', () => {
  it('applyState is idempotent and incremental', async () => {
    await deleteDb(DBN);
    const db = await openDb(DBN);
    const full = state(0, 1, {
      assignments: [{ subject_id: 3, srs_stage: 5 }, { subject_id: 4, srs_stage: 4 }],
      srs_events: [{ id: 1, subject_id: 3, from: 4, to: 5, at: '2026-08-20T00:00:00Z' }],
      syncs: [{ id: 1, at: '2026-08-20T00:00:00Z' }],
    });
    await applyState(db, full);
    await applyState(db, full);
    assertEqual(await db.count('assignments'), 2);
    assertEqual(await db.count('srs_events'), 1);
    assertEqual(await db.count('syncs'), 1);
    assertEqual(await db.getMeta('server_version'), 1);
    assertEqual((await db.getMeta('user')).id, 'u-1');

    const inc = state(1, 2, {
      assignments: [{ subject_id: 3, srs_stage: 6 }],
      srs_events: [{ id: 2, subject_id: 3, from: 5, to: 6, at: '2026-08-21T00:00:00Z' }],
      syncs: [{ id: 2, at: '2026-08-21T00:00:00Z' }],
    });
    await applyState(db, inc);
    assertEqual(await db.count('assignments'), 2, 'incremental keeps untouched rows');
    assertEqual((await db.get('assignments', 3)).srs_stage, 6);
    assertEqual(await db.count('srs_events'), 2);
    assertEqual(await db.getMeta('server_version'), 2);

    // a since=0 pull replaces history wholesale (account recreated on the server)
    await applyState(db, state(0, 1, { syncs: [{ id: 1, at: '2026-09-01T00:00:00Z' }] }));
    assertEqual(await db.count('srs_events'), 0);
    assertEqual(await db.count('syncs'), 1);
    const m = await loadModel(db);
    assertEqual(m.syncDates, ['2026-09-01T00:00:00Z']);
    assertEqual(m.lastSync, '2026-08-22T09:00:00Z');
    db.close();
  });

  it('hasLocalHistory only for pre-server browsers; collectSeed round-trips', async () => {
    await deleteDb(DBN);
    const db = await openDb(DBN);
    assert(!(await hasLocalHistory(db)), 'empty db');
    await db.setMeta('history_since', '2026-08-01T00:00:00Z');
    await db.setMeta('last_sync', '2026-08-22T00:00:00Z');
    await db.setMeta('cursors', { subjects: 's', assignments: 'a', review_statistics: 'r' });
    await db.putAll('assignments', [{ subject_id: 1, srs_stage: 1 }]);
    await db.putAll('review_statistics', [{ subject_id: 1, meaning_correct: 1 }]);
    await db.putAll('level_progressions', [{ id: 9, level: 1 }]);
    await db.addAll('srs_events', [{ subject_id: 1, from: 0, to: 1, at: '2026-08-02T00:00:00Z' }]);
    await db.addAll('review_events', [{ at: '2026-08-02T00:00:00Z', reviews: 3 }]);
    await db.addAll('syncs', [{ at: '2026-08-02T00:00:00Z' }]);
    assert(await hasLocalHistory(db), 'pre-server history present');

    const seed = await collectSeed(db);
    assertEqual(seed.history_since, '2026-08-01T00:00:00Z');
    assertEqual(seed.cursors, { assignments: 'a', review_statistics: 'r' });
    assertEqual(seed.assignments.length, 1);
    assertEqual(seed.stats.length, 1);
    assertEqual(seed.progressions.length, 1);
    assertEqual(seed.srs_events.length, 1);
    assertEqual(seed.review_events[0].reviews, 3);
    assertEqual(seed.syncs.length, 1);

    await db.setMeta('server_version', 0);
    assert(!(await hasLocalHistory(db)), 'once connected (even at version 0) never ask again');
    db.close();
  });
});
