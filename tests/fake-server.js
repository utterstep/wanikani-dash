// In-page fake of the Worker's /api for browser tests: the JS reference account logic
// (tests/reference/) over an in-memory store, with WaniKani served by the same fixture shim
// the page uses. No wrangler needed for the e2e run.

import { Account } from './reference/account-core.js';
import { bearer, resolveUser } from './reference/auth.js';
import { AuthError } from '../public/js/api.js';
import { MemoryStore } from './store-memory.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noCache = { match: async () => undefined, put: async () => {} };

/**
 * @param {{wkFetch: typeof fetch, base?: string}} opts  wkFetch may switch scenarios between calls.
 * @returns {typeof fetch} handles /api/* URLs (relative or absolute)
 */
const PERSIST = '__mock_server'; // survives reloads in the e2e like a real server would

export function makeFakeServer({ wkFetch, base = 'https://api.wanikani.com/v2', persist = typeof localStorage !== 'undefined' }) {
  const accounts = new Map(); // WK user id → Account
  const saved = persist ? JSON.parse(localStorage.getItem(PERSIST) ?? '{}') : {};
  const save = () => {
    if (!persist) return;
    try { localStorage.setItem(PERSIST, JSON.stringify(Object.fromEntries([...accounts].map(([id, a]) => [id, a.store.dump()])))); } catch { /* quota (real fixtures) */ }
  };
  const server = async (url, init = {}) => {
    const request = new Request(new URL(url, globalThis.location?.origin ?? 'http://fake'), init);
    const token = bearer(request);
    if (!token) return json({ error: 'Missing token' }, 401);
    let user;
    try {
      user = await resolveUser(token, { fetch: wkFetch, base, cache: noCache });
    } catch (e) {
      if (e instanceof AuthError) return json({ error: 'WaniKani rejected the token' }, 401);
      return json({ error: e.message }, 502);
    }
    let acc = accounts.get(user.id);
    if (!acc) {
      const store = new MemoryStore();
      if (saved[user.id]) store.load(saved[user.id]);
      // throttleMs 0: every page load syncs, so a reload with a new scenario behaves like the alarm having fired
      acc = new Account({ store, base, getFetch: async () => wkFetch, throttleMs: 0, arm: async () => { acc.armed = true; }, disarm: async () => { acc.armed = false; }, destroy: async () => store.reset() });
      accounts.set(user.id, acc);
    }
    const res = await acc.handle(request, { user, token });
    save();
    return res;
  };
  server.accounts = accounts;
  return server;
}
