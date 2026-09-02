// Table names shared by the JS reference implementation and the fake server's memory store.
export const KEYED = { assignments: 'subject_id', review_statistics: 'subject_id', level_progressions: 'id' };
export const EVENTS = ['srs_events', 'review_events', 'syncs'];
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
