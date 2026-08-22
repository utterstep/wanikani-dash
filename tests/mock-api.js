// fetch() shim serving WK-shaped collection responses from fixtures.
// scenario: 'a' | 'b' (synthetic) | 'real' (tests/fixtures/real-*.json recorded by scripts/record-fixtures.sh)

import { fixtures } from './fixtures/synthetic.js';

const PAGE = 500;

export async function installMock(scenario = 'a') {
  let data;
  if (scenario === 'real') {
    const load = async (n) => (await fetch(new URL(`./fixtures/real-${n}.json`, import.meta.url))).json();
    const [user, subjects, assignments, review_statistics, level_progressions] = await Promise.all(['user', 'subjects', 'assignments', 'review_statistics', 'level_progressions'].map(load));
    data = { user, subjects, assignments, review_statistics, level_progressions };
  } else {
    data = fixtures(scenario);
  }
  return makeFetch(data);
}

export function makeFetch(data, { auth = true, log = [] } = {}) {
  return async (url, init = {}) => {
    log.push(url);
    const u = new URL(url);
    const token = (init.headers?.Authorization ?? '').replace('Bearer ', '');
    if (auth && token !== 'test-token' && !token.match(/^[0-9a-f-]{36}$/)) return json({ error: 'Unauthorized', code: 401 }, 401);
    const path = u.pathname.replace(/^\/v2\//, '');
    if (path === 'user') return json(data.user);
    const rows = data[path];
    if (!rows) return json({ error: 'Not Found', code: 404 }, 404);
    const after = u.searchParams.get('updated_after');
    const filtered = after ? rows.filter((r) => r.data_updated_at > after) : rows;
    const ids = filtered.map((r) => r.id).sort((a, b) => a - b);
    const afterId = Number(u.searchParams.get('page_after_id') ?? -1);
    const page = filtered.filter((r) => r.id > afterId).sort((a, b) => a.id - b.id).slice(0, PAGE);
    const last = page[page.length - 1]?.id;
    const hasMore = last != null && ids.some((id) => id > last);
    const next = new URL(u); next.searchParams.set('page_after_id', String(last));
    return json({ object: 'collection', url, pages: { per_page: PAGE, next_url: hasMore ? next.toString() : null, previous_url: null }, total_count: filtered.length, data_updated_at: null, data: page });
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
