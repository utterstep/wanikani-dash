// The JS reference account logic (the e2e's fake server), run in the browser over the in-memory store.
import { describe, it, assertEqual, assert } from './harness.js';
import { Account } from './reference/account-core.js';
import { MemoryStore } from './store-memory.js';
import { fixtures, NOW_A, NOW_B } from './fixtures/synthetic.js';
import { makeFetch } from './mock-api.js';

const user = { id: 'u-1', username: 'testuser', level: 4 };
const req = (method, path, body) => new Request(`http://fake/api${path}`, { method, body: body ? JSON.stringify(body) : undefined });

const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function account() {
  const store = new MemoryStore();
  let data = fixtures('a');
  const acc = new Account({
    store, base: 'https://api.wanikani.com/v2',
    now: () => new Date(NOW_A),
    getFetch: async () => (u, i) => makeFetch(data)(u, i),
    arm: async () => { acc.armed = true; }, disarm: async () => { acc.armed = false; }, destroy: async () => store.reset(),
  });
  acc.scenario_ = (s) => { data = fixtures(s); };
  return acc;
}
const call = async (acc, method, path, body) => { const r = await acc.handle(req(method, path, body), { user, token: 'test-token' }); return { status: r.status, body: await r.json() }; };

describe('account (server logic)', () => {
  it('bootstraps, throttles, diffs on the next poll, serves incremental state', async () => {
    const acc = account();
    let r = await call(acc, 'GET', '/state?since=0');
    assertEqual(r.body.account.status, 'empty');
    assertEqual(r.body.assignments, []);
    assert(!acc.armed, 'no alarm before first sync');

    r = await call(acc, 'POST', '/sync');
    assert(r.body.ran && r.body.firstRun);
    assertEqual(r.body.version, 1);
    assert(acc.armed, 'alarm armed after sync');

    r = await call(acc, 'POST', '/sync');
    assertEqual(r.body.ran, false, 'throttled within a minute');

    r = await call(acc, 'GET', '/state?since=0');
    assertEqual(r.body.account.status, 'active');
    assertEqual(r.body.assignments.length, 8);
    assertEqual(r.body.review_statistics.length, 7);
    assertEqual(r.body.srs_events.length, 0);
    assertEqual(r.body.syncs.length, 1);

    acc.scenario_('b');
    const s2 = await acc.runSync({ now: new Date(NOW_B) });
    assertEqual(s2.srsEvents, 4); assertEqual(s2.reviews, 3); assertEqual(s2.version, 2);

    r = await call(acc, 'GET', '/state?since=1');
    assertEqual(r.body.since, 1);
    assertEqual(r.body.srs_events.length, 4);
    assertEqual(r.body.review_events.length, 1);
    assertEqual(r.body.review_events[0].id, 1);
    assertEqual(r.body.assignments.length, 4, 'only changed assignments');
    assertEqual(r.body.syncs.length, 1);

    r = await call(acc, 'GET', '/state?since=99');
    assertEqual(r.body.since, 0, 'a since beyond the server version restarts from zero');
    assertEqual(r.body.srs_events.length, 4);

    // identical data again → no new events (dedupe + no deltas)
    const s3 = await acc.runSync({ now: new Date(NOW_B + 3600e3) });
    assertEqual(s3.srsEvents, 0); assertEqual(s3.reviews, 0);

    r = await call(acc, 'POST', '/seed', { assignments: [] });
    assertEqual(r.status, 400);
  });

  it('seeds an empty account, refuses a second seed, deletes', async () => {
    const acc = account();
    const seed = {
      history_since: new Date(NOW_A - 10 * 86400e3).toISOString(),
      last_sync: new Date(NOW_A).toISOString(),
      cursors: { assignments: new Date(NOW_A - 86400e3).toISOString(), review_statistics: new Date(NOW_A - 86400e3).toISOString() },
      assignments: [{ subject_id: 3, subject_type: 'kanji', srs_stage: 5, data_updated_at: '2026-08-18T00:00:00Z' }],
      stats: [{ subject_id: 3, subject_type: 'kanji', meaning_correct: 9, meaning_incorrect: 4, reading_correct: 8, reading_incorrect: 5 }],
      progressions: [{ id: 300, level: 1 }],
      srs_events: [{ id: 7, subject_id: 3, subject_type: 'kanji', from: 4, to: 5, at: '2026-08-15T00:00:00Z', seen_at: '2026-08-15T01:00:00Z' }],
      review_events: [{ id: 3, at: '2026-08-15T01:00:00Z', reviews: 12, items: 10 }],
      syncs: [{ id: 1, at: '2026-08-15T01:00:00Z', srs_events: 1, reviews: 12 }],
    };
    let r = await call(acc, 'POST', '/seed', seed);
    assertEqual(r.status, 200);
    assertEqual(r.body.version, 1);
    assert(acc.armed);
    r = await call(acc, 'GET', '/state?since=0');
    assertEqual(r.body.account.status, 'active');
    assertEqual(r.body.account.history_since, seed.history_since);
    assertEqual(r.body.srs_events[0].id, 1, 'server assigns its own ids');
    assertEqual(r.body.srs_events[0].to, 5);
    assertEqual(r.body.review_events[0].reviews, 12);

    r = await call(acc, 'POST', '/seed', seed);
    assertEqual(r.status, 409);

    // the next poll diffs against the seeded snapshot: kanji 3 goes 5→6 in scenario b
    acc.scenario_('b');
    const s = await acc.runSync({ now: new Date(NOW_B) });
    assert(s.srsEvents >= 1);
    r = await call(acc, 'GET', '/state?since=1');
    assert(r.body.srs_events.some((e) => e.subject_id === 3 && e.from === 5 && e.to === 6));

    r = await call(acc, 'DELETE', '/account');
    assertEqual(r.body.ok, true);
    assert(!acc.armed);
    r = await call(acc, 'GET', '/state?since=0');
    assertEqual(r.body.account.status, 'empty');
    assertEqual(r.body.srs_events, []);
  });

  it('produces the same /api/state as the Rust server (tests/fixtures/golden-state.json)', async () => {
    const golden = await (await fetch(new URL('./fixtures/golden-state.json', import.meta.url))).json();
    const acc = account();
    await call(acc, 'POST', '/sync'); // bootstrap at NOW_A
    acc.scenario_('b');
    await acc.runSync({ now: new Date(NOW_B) }); // the poll
    const r = await call(acc, 'GET', '/state?since=0');
    assertEqual(JSON.parse(canonical(r.body)), JSON.parse(canonical(golden)), 'JS double drifted from the Rust server; regenerate with UPDATE_GOLDEN=1 cargo nextest run and port the change');
  });

  it('marks the account auth_failed when WK revokes the stored token, recovers with a valid one', async () => {
    const acc = account();
    let r = await acc.handle(req('POST', '/sync'), { user, token: 'dying-token' });
    assertEqual(r.status, 401);
    assertEqual(await acc.store.getMeta('status'), 'auth_failed');
    assert(!acc.armed);
    r = await call(acc, 'GET', '/state?since=0');
    assertEqual(r.body.account.status, 'active');
    assert(acc.armed, 're-armed by a request with a working token');
    assertEqual(await acc.store.getMeta('token'), 'test-token');
  });
});
