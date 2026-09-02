// The built Rust Worker + Durable Object in workerd (Cloudflare vitest integration).
// api.wanikani.com is played by tests/worker/wk-mock.mjs (see vitest.config.mjs).
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';

const USER_ID = '5a6a5234-a392-4a87-8f3f-33342afe8a42'; // tests/fixtures/synthetic.js
const TOKEN = 'test-token';
const TOKEN2 = '11111111-1111-1111-1111-111111111111'; // any uuid-shaped token is "valid" for the mock

const setScenario = (s) => env.WK_MOCK.fetch(`http://wk-mock/__scenario/${s}`, { method: 'POST' });

const h = (token) => ({ Authorization: `Bearer ${token}` });
const api = async (method, path, { token = TOKEN, body } = {}) => {
  const res = await SELF.fetch(`https://wkdash.test/api${path}`, { method, headers: { ...h(token), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const stub = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(USER_ID));
const alarmAt = () => runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
const meta = (key) => runInDurableObject(stub(), (_, state) => {
  const row = state.storage.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? JSON.parse(row.value) : undefined;
});

describe('worker', () => {
  // the DO instance lives across tests; start each from an empty account
  beforeEach(async () => { await setScenario('a'); await api('DELETE', '/account'); });

  it('serves static assets outside /api', async () => {
    const res = await SELF.fetch('https://wkdash.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('WaniKani');
  });

  it('allows the old GitHub Pages origin cross-origin, nobody else', async () => {
    const pre = await SELF.fetch('https://wkdash.test/api/seed', { method: 'OPTIONS', headers: { Origin: 'https://utterstep.github.io', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://utterstep.github.io');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    const res = await SELF.fetch('https://wkdash.test/api/state', { headers: { ...h(TOKEN), Origin: 'https://utterstep.github.io' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://utterstep.github.io');
    const other = await SELF.fetch('https://wkdash.test/api/state', { headers: { ...h(TOKEN), Origin: 'https://evil.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await SELF.fetch('https://wkdash.test/api/seed', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('rejects missing and invalid tokens', async () => {
    expect((await SELF.fetch('https://wkdash.test/api/state')).status).toBe(401);
    expect((await api('GET', '/state', { token: 'nope' })).status).toBe(401);
  });

  it('empty account → bootstrap sync → poll via alarm → incremental state', async () => {
    let r = await api('GET', '/state?since=0');
    expect(r.body.account.status).toBe('empty');
    expect(r.body.account.user.username).toBe('testuser');
    expect(await alarmAt()).toBeNull();

    r = await api('POST', '/sync');
    expect(r.body).toMatchObject({ ran: true, firstRun: true, version: 1 });
    expect(await alarmAt()).toBeGreaterThan(Date.now());

    r = await api('POST', '/sync');
    expect(r.body.ran).toBe(false); // throttled

    r = await api('GET', '/state?since=0');
    expect(r.body.account.status).toBe('active');
    expect(r.body.assignments).toHaveLength(8);
    expect(r.body.assignments[0]).toMatchObject({ subject_id: 1, srs_stage: 9 });
    expect(r.body.srs_events).toHaveLength(0);

    // scenario b = a few days later, after reviews; the alarm polls it
    await setScenario('b');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await alarmAt()).toBeGreaterThan(Date.now()); // re-armed

    r = await api('GET', '/state?since=1');
    expect(r.body.account.version).toBe(2);
    expect(r.body.srs_events).toHaveLength(4);
    expect(r.body.srs_events[0].id).toBe(1);
    expect(r.body.review_events).toHaveLength(1);
    expect(r.body.review_events[0].reviews).toBe(3);
    expect(r.body.assignments).toHaveLength(4);
    expect(r.body.syncs).toHaveLength(1);

    // rotation: a different valid token for the same WK account sees the same data and replaces the stored token
    r = await api('GET', '/state?since=0', { token: TOKEN2 });
    expect(r.body.srs_events).toHaveLength(4);
    expect(await meta('token')).toBe(TOKEN2);
  });

  it('seed, refuse second seed, delete', async () => {
    const seed = {
      history_since: '2026-07-01T00:00:00Z', last_sync: '2026-08-20T10:00:00Z',
      cursors: { assignments: '2026-08-19T00:00:00Z', review_statistics: '2026-08-19T00:00:00Z' },
      assignments: [{ subject_id: 3, subject_type: 'kanji', srs_stage: 5, data_updated_at: '2026-08-18T00:00:00Z' }],
      stats: [{ subject_id: 3, subject_type: 'kanji', meaning_correct: 9, meaning_incorrect: 4, reading_correct: 8, reading_incorrect: 5 }],
      progressions: [{ id: 300, level: 1 }],
      srs_events: [{ id: 42, subject_id: 3, subject_type: 'kanji', from: 4, to: 5, at: '2026-08-15T00:00:00Z', seen_at: '2026-08-15T01:00:00Z' }],
      review_events: [{ id: 5, at: '2026-08-15T01:00:00Z', reviews: 12, items: 10 }],
      syncs: [{ id: 1, at: '2026-08-15T01:00:00Z', srs_events: 1, reviews: 12 }],
    };
    let r = await api('POST', '/seed', { body: seed });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, version: 1, srs_events: 1 });
    expect(await alarmAt()).toBeGreaterThan(Date.now());

    r = await api('GET', '/state?since=0');
    expect(r.body.account.history_since).toBe('2026-07-01T00:00:00Z');
    expect(r.body.srs_events[0]).toMatchObject({ id: 1, subject_id: 3, to: 5 });

    expect((await api('POST', '/seed', { body: seed })).status).toBe(409);
    expect((await api('POST', '/seed', { body: { assignments: [] } })).status).toBe(400);

    await setScenario('b');
    r = await api('POST', '/sync');
    expect(r.body.ran).toBe(true);
    r = await api('GET', '/state?since=1');
    expect(r.body.srs_events.some((e) => e.subject_id === 3 && e.from === 5 && e.to === 6)).toBe(true);

    r = await api('DELETE', '/account');
    expect(r.body.ok).toBe(true);
    expect(await alarmAt()).toBeNull();
    r = await api('GET', '/state?since=0');
    expect(r.body.account.status).toBe('empty');
    expect(r.body.srs_events).toEqual([]);
  });

  it('a revoked stored token stops polling until a working token shows up', async () => {
    let r = await api('POST', '/sync', { token: 'dying-token' });
    expect(r.status).toBe(401);
    expect(await meta('status')).toBe('auth_failed');
    expect(await alarmAt()).toBeNull();
    r = await api('GET', '/state?since=0');
    expect(r.body.account.status).toBe('active');
    expect(await alarmAt()).toBeGreaterThan(Date.now());
  });
});
