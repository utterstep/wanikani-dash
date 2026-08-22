import { describe, it, assertEqual, assert } from './harness.js';
import { openDb, deleteDb } from '../js/db.js';
import { WkApi, AuthError } from '../js/api.js';
import { sync, loadModel } from '../js/sync.js';
import { fixtures, NOW_A, NOW_B } from './fixtures/synthetic.js';
import { makeFetch } from './mock-api.js';

const DBN = 'wkdash-test';

describe('sync', () => {
  it('first run stores snapshot, no events; second run emits events and advances cursors', async () => {
    await deleteDb(DBN);
    const db = await openDb(DBN);
    const logA = [];
    const apiA = new WkApi('test-token', { fetch: makeFetch(fixtures('a'), { log: logA }) });
    const r1 = await sync(apiA, db, { now: new Date(NOW_A) });
    assert(r1.firstRun); assertEqual(r1.srsEvents, 0); assertEqual(r1.reviews, 0);
    assertEqual(await db.count('subjects'), 8);
    assertEqual(await db.count('assignments'), 8);
    assertEqual(await db.count('review_statistics'), 7);
    assertEqual(await db.count('srs_events'), 0);
    assert(!logA.some((u) => u.includes('updated_after')), 'first run is a full fetch');

    const logB = [];
    const apiB = new WkApi('test-token', { fetch: makeFetch(fixtures('b'), { log: logB }) });
    const r2 = await sync(apiB, db, { now: new Date(NOW_B) });
    assert(!r2.firstRun);
    assertEqual(r2.srsEvents, 4);
    assertEqual(r2.reviews, 3);
    assert(logB.some((u) => u.includes('/assignments?updated_after=')), 'incremental assignments fetch');
    assert(logB.some((u) => u.includes('/subjects?updated_after=')), 'incremental subjects fetch');

    const m = await loadModel(db);
    assertEqual(m.user.level, 4);
    assertEqual(m.srsEvents.length, 4);
    assertEqual(m.reviewEvents.length, 1);
    assertEqual(m.reviewEvents[0].at, new Date(NOW_B).toISOString());
    assertEqual(m.syncDates.length, 2);
    assertEqual(m.assignmentsById.get(3).srs_stage, 6);
    assert(m.historySince === new Date(NOW_A).toISOString());

    // third sync with identical data → nothing new
    const r3 = await sync(apiB, db, { now: new Date(NOW_B + 3600e3) });
    assertEqual(r3.srsEvents, 0); assertEqual(r3.reviews, 0);
    assertEqual(await db.count('review_events'), 1);
    db.close();
  });

  it('throws AuthError on 401', async () => {
    const api = new WkApi('bad', { fetch: makeFetch(fixtures('a')) });
    let err;
    try { await api.getOne('/user'); } catch (e) { err = e; }
    assert(err instanceof AuthError);
  });

  it('follows pagination', async () => {
    const big = { ...fixtures('a'), subjects: Array.from({ length: 1203 }, (_, i) => ({ id: i + 1, object: 'kanji', data_updated_at: '2026-01-01T00:00:00Z', data: { level: 1, meanings: [], readings: [] } })) };
    const log = [];
    const api = new WkApi('test-token', { fetch: makeFetch(big, { log }) });
    const rows = await api.getAll('/subjects');
    assertEqual(rows.length, 1203);
    assertEqual(log.filter((u) => u.includes('/subjects')).length, 3);
  });
});
