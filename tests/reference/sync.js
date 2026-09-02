// JS reference of the server-side sync (production: crates/wkdash-core/src/sync.rs).
// KEEP IN SYNC with the Rust code; see account-core.js for the golden-fixture check.
//
// Store interface:
//   getMeta(key) / setMeta(key, value)
//   getMany(table, keys)            → (row|undefined)[]          keyed tables
//   putAll(table, rows, syncId)                                  keyed tables (upsert)
//   addAll(table, rows, syncId)     → number inserted            event tables (srs_events dedupe)
//   since(table, syncId)            → rows (event rows carry id)
//
// Every row written by one run carries that run's sync id (meta.version) so clients can pull
// incrementally with ?since=<version>.

import { slimAssignment, slimStat, slimProgression, diffAssignments, diffStats } from '../../public/js/diff.js';
import { slimUser } from './auth.js';

const byKey = (rows, k) => new Map(rows.map((r) => [r[k], r]));

/** Slim progressions, minus the ones already stored identically (every write costs an index write too). */
async function progressionsChanged(raw, store) {
  const rows = raw.map(slimProgression);
  const prev = await store.getMany('level_progressions', rows.map((p) => p.id));
  return rows.filter((p, i) => JSON.stringify(prev[i]) !== JSON.stringify(p));
}

/**
 * @param {import('../public/js/api.js').WkApi} api
 * @param {object} store
 * @returns {Promise<{firstRun:boolean, srsEvents:number, reviews:number, version:number}>}
 */
export async function sync(api, store, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const cursors = (await store.getMeta('cursors')) ?? {};
  const firstRun = !(await store.getMeta('last_sync'));
  const syncId = ((await store.getMeta('version')) ?? 0) + 1;

  // 1. user (level, vacation)
  await store.setMeta('user', slimUser(await api.getOne('/user')));

  // 2. level progressions (small: refetch all; only changed rows are written)
  const progressions = progressionsChanged(await api.getAll('/level_progressions'), store);
  await store.putAll('level_progressions', await progressions, syncId);

  // 3. assignments + review statistics (incremental)
  const asgParams = cursors.assignments ? { updated_after: cursors.assignments } : {};
  const statParams = cursors.review_statistics ? { updated_after: cursors.review_statistics } : {};
  const asgRaw = await api.getAll('/assignments', asgParams);
  const statRaw = await api.getAll('/review_statistics', statParams);
  const asg = asgRaw.map(slimAssignment);
  const stats = statRaw.map(slimStat);

  // 4. diff against stored rows
  const prevAsg = byKey((await store.getMany('assignments', asg.map((a) => a.subject_id))).filter(Boolean), 'subject_id');
  const prevStats = byKey((await store.getMany('review_statistics', stats.map((s) => s.subject_id))).filter(Boolean), 'subject_id');
  const { events } = diffAssignments(prevAsg, asg, nowIso);
  const reviewEvent = diffStats(prevStats, stats, nowIso);

  // 5. persist: events first, then snapshot (changed rows only), then cursors (a crash never loses events)
  const srsEvents = await store.addAll('srs_events', events, syncId);
  if (reviewEvent) await store.addAll('review_events', [reviewEvent], syncId);
  const changed = (rows, prevById, key) => rows.filter((r) => JSON.stringify(prevById.get(r[key])) !== JSON.stringify(r));
  await store.putAll('assignments', changed(asg, prevAsg, 'subject_id'), syncId);
  await store.putAll('review_statistics', changed(stats, prevStats, 'subject_id'), syncId);
  await store.addAll('syncs', [{ at: nowIso, srs_events: srsEvents, reviews: reviewEvent?.reviews ?? 0 }], syncId);

  // Cursor = max data_updated_at seen (safer than "now" against clock skew). Keep the old cursor if nothing came back.
  const maxUpd = (rows, prev) => rows.reduce((m, r) => (r.data_updated_at > m ? r.data_updated_at : m), prev ?? '');
  await store.setMeta('cursors', {
    assignments: maxUpd(asgRaw, cursors.assignments) || nowIso,
    review_statistics: maxUpd(statRaw, cursors.review_statistics) || nowIso,
  });
  if (firstRun) await store.setMeta('history_since', nowIso);
  await store.setMeta('last_sync', nowIso);
  await store.setMeta('status', 'active');
  await store.setMeta('version', syncId);

  return { firstRun, srsEvents, reviews: reviewEvent?.reviews ?? 0, version: syncId };
}

const SEED_ARRAYS = ['assignments', 'stats', 'progressions', 'srs_events', 'review_events', 'syncs'];

/** Validate a seed body (a browser's local history). Returns an error string or null. */
export function validateSeed(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  for (const k of SEED_ARRAYS) if (!Array.isArray(body[k])) return `${k} must be an array`;
  if (!body.assignments.length) return 'assignments is empty';
  if (typeof body.history_since !== 'string') return 'history_since missing';
  if (!body.cursors?.assignments || !body.cursors?.review_statistics) return 'cursors missing';
  return null;
}

/** Seed an empty account from a browser's IndexedDB export. Becomes version 1. */
export async function seed(store, body, { now = new Date() } = {}) {
  const syncId = 1;
  const strip = (rows) => rows.map(({ id, ...r }) => r); // local autoincrement keys are meaningless here
  await store.putAll('assignments', body.assignments, syncId);
  await store.putAll('review_statistics', body.stats, syncId);
  await store.putAll('level_progressions', body.progressions, syncId);
  const srs = await store.addAll('srs_events', strip(body.srs_events), syncId);
  const rev = await store.addAll('review_events', strip(body.review_events), syncId);
  const syncs = await store.addAll('syncs', strip(body.syncs), syncId);
  await store.setMeta('cursors', { assignments: body.cursors.assignments, review_statistics: body.cursors.review_statistics });
  await store.setMeta('history_since', body.history_since);
  await store.setMeta('last_sync', body.last_sync ?? now.toISOString());
  await store.setMeta('status', 'active');
  await store.setMeta('version', syncId);
  return { version: syncId, srs_events: srs, review_events: rev, syncs };
}
