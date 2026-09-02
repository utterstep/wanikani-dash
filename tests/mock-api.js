// fetch() shims for tests.
//   mockWk(data)         sync (url, token) → {status, body}; makeFetch wraps it as a fetch().
//   installMock(scen)    page-level: {wk, server} fetches — WK from fixtures, /api from tests/fake-server.js
//                        running the real server logic in-page. window.__mock.scenario('b') switches data.
// scenario: 'a' | 'b' (synthetic) | 'real' (tests/fixtures/real-*.json recorded by scripts/record-fixtures.sh)

import { fixtures } from './fixtures/synthetic.js';

const PAGE = 500;

async function loadData(scenario) {
  if (scenario !== 'real') return fixtures(scenario);
  const load = async (n) => (await fetch(new URL(`./fixtures/real-${n}.json`, import.meta.url))).json();
  const [user, subjects, assignments, review_statistics, level_progressions] = await Promise.all(['user', 'subjects', 'assignments', 'review_statistics', 'level_progressions'].map(load));
  return { user, subjects, assignments, review_statistics, level_progressions };
}

/** Pre-server browser state (history collected locally, no server_version) so the seed dialog can be exercised. */
async function injectLegacyHistory() {
  const [{ openDb }, { slimAssignment, slimStat, slimProgression, slimSubject }, { NOW_A }] = await Promise.all([import('../public/js/db.js'), import('../public/js/diff.js'), import('./fixtures/synthetic.js')]);
  const db = await openDb();
  if ((await db.getMeta('server_version')) !== undefined || (await db.getMeta('history_since'))) { db.close(); return; }
  const a = fixtures('a');
  const DAY = 86_400_000;
  const iso = (t) => new Date(t).toISOString();
  await db.putAll('subjects', a.subjects.map(slimSubject));
  await db.putAll('assignments', a.assignments.map(slimAssignment));
  await db.putAll('review_statistics', a.review_statistics.map(slimStat));
  await db.putAll('level_progressions', a.level_progressions.map(slimProgression));
  await db.addAll('srs_events', [{ subject_id: 2, subject_type: 'kanji', from: 7, to: 8, at: iso(NOW_A - 5 * DAY), seen_at: iso(NOW_A - 5 * DAY) }]);
  await db.addAll('review_events', [{ at: iso(NOW_A - 5 * DAY), reviews: 10, items: 8, meaning_correct_d: 8, meaning_incorrect_d: 2, reading_correct_d: 7, reading_incorrect_d: 1 }]);
  await db.addAll('syncs', [{ at: iso(NOW_A - 5 * DAY), srs_events: 1, reviews: 10 }, { at: iso(NOW_A), srs_events: 0, reviews: 0 }]);
  await db.setMeta('user', { username: 'testuser', level: 4 }); // legacy: no id
  await db.setMeta('cursors', { subjects: iso(NOW_A - 100 * DAY), assignments: iso(NOW_A - 2 * DAY), review_statistics: iso(NOW_A - 2 * DAY) });
  await db.setMeta('history_since', iso(NOW_A - 5 * DAY));
  await db.setMeta('last_sync', iso(NOW_A));
  db.close();
}

export async function installMock(scenario = 'a') {
  if (new URLSearchParams(globalThis.location?.search ?? '').has('legacy')) await injectLegacyHistory();
  let data = await loadData(scenario);
  const wk = (url, init) => makeFetch(data)(url, init);
  const { makeFakeServer } = await import('./fake-server.js');
  const server = makeFakeServer({ wkFetch: wk });
  globalThis.__mock = { scenario: async (s) => { data = await loadData(s); }, server };
  return { wk, server };
}

/** Sync core of the WK mock: (url, token) → {status, body}. Used by makeFetch and by fetchMock in tests/worker/. */
export function mockWk(data, { auth = true, log = [] } = {}) {
  return (url, token = '') => {
    log.push(url);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v2\//, '');
    if (auth && token !== 'test-token' && token !== 'dying-token' && !token.match(/^[0-9a-f-]{36}$/)) return { status: 401, body: { error: 'Unauthorized', code: 401 } };
    if (token === 'dying-token' && path !== 'user') return { status: 401, body: { error: 'Unauthorized', code: 401 } }; // valid for /user, then revoked
    if (path === 'user') return { status: 200, body: data.user };
    if (path === 'summary') return data.summary ? { status: 200, body: data.summary } : { status: 401, body: { error: 'The personal access token does not grant permission to access this endpoint', code: 401 } };
    const rows = data[path];
    if (!rows) return { status: 404, body: { error: 'Not Found', code: 404 } };
    const after = u.searchParams.get('updated_after');
    const filtered = after ? rows.filter((r) => r.data_updated_at > after) : rows;
    const ids = filtered.map((r) => r.id).sort((a, b) => a - b);
    const afterId = Number(u.searchParams.get('page_after_id') ?? -1);
    const page = filtered.filter((r) => r.id > afterId).sort((a, b) => a.id - b.id).slice(0, PAGE);
    const last = page[page.length - 1]?.id;
    const hasMore = last != null && ids.some((id) => id > last);
    const next = new URL(u); next.searchParams.set('page_after_id', String(last));
    return { status: 200, body: { object: 'collection', url, pages: { per_page: PAGE, next_url: hasMore ? next.toString() : null, previous_url: null }, total_count: filtered.length, data_updated_at: null, data: page } };
  };
}

export function makeFetch(data, opts = {}) {
  const mock = mockWk(data, opts);
  return async (url, init = {}) => {
    const token = (init.headers?.Authorization ?? init.headers?.get?.('Authorization') ?? '').replace('Bearer ', '');
    const { status, body } = mock(url, token);
    return json(body, status);
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
