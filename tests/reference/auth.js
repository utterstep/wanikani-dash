// Token → WaniKani account. The dashboard is keyed by WK's stable user id, so any valid
// token for the same account (rotation included) lands on the same data.
// Resolution hits WK /user once per token and is cached for an hour in the Cache API.

import { WkApi } from '../../public/js/api.js';

const TTL = 3600;

export function bearer(request) {
  const h = request.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Slim of WK /user we keep and hand to the DO. */
export function slimUser(u) {
  const d = u.data;
  return {
    id: d.id,
    username: d.username,
    level: d.level,
    started_at: d.started_at,
    current_vacation_started_at: d.current_vacation_started_at,
    subscription: d.subscription,
  };
}

/**
 * @returns {Promise<object>} slim user; throws AuthError (401) or ApiError/OfflineError.
 */
export async function resolveUser(token, { fetch, base, cache = caches.default }) {
  const key = new Request(`https://wkdash.internal/token/${await sha256(token)}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const user = slimUser(await new WkApi(token, { fetch, base }).getOne('/user'));
  if (!user.id) throw new Error('WK /user returned no id');
  await cache.put(key, new Response(JSON.stringify(user), { headers: { 'Cache-Control': `max-age=${TTL}`, 'Content-Type': 'application/json' } }));
  return user;
}
