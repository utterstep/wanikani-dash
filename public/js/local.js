// The two things the browser still fetches from WaniKani directly: subjects (global, big,
// cached forever in IndexedDB, incremental) and /summary (lessons/reviews available right now).

import { slimSubject } from './diff.js';

/** Bump when slimSubject gains a field: the cache is rebuilt from scratch once. 2 = components + image. */
export const SUBJECTS_SCHEMA = 2;

/**
 * @param {import('./api.js').WkApi} api
 * @param {import('./db.js').Db} db
 */
export async function refreshLocal(api, db, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  let cursors = (await db.getMeta('cursors')) ?? {};
  if ((await db.getMeta('subjects_schema')) !== SUBJECTS_SCHEMA) {
    await db.clear('subjects');
    cursors = { ...cursors, subjects: undefined };
  }

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

  const subjects = await api.getAll('/subjects', cursors.subjects ? { updated_after: cursors.subjects } : {});
  if (subjects.length) await db.putAll('subjects', subjects.map(slimSubject));
  const maxUpd = subjects.reduce((m, r) => (r.data_updated_at > m ? r.data_updated_at : m), cursors.subjects ?? '');
  await db.setMeta('cursors', { ...cursors, subjects: maxUpd || nowIso });
  await db.setMeta('subjects_schema', SUBJECTS_SCHEMA);
}
