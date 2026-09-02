// Client for the dashboard's own /api (the Cloudflare Worker). Authenticates with the WK token;
// the server resolves it to the WK account. Errors map onto the same classes as api.js.

import { AuthError, OfflineError, ApiError } from './api.js';

export class ServerApi {
  /** @param {string} token @param {{fetch?: typeof fetch, base?: string, headers?: Record<string,string>}} opts */
  constructor(token, opts = {}) {
    this.token = token;
    this.fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.base = opts.base ?? '/api';
    this.extraHeaders = opts.headers ?? {};
  }

  async request(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...this.extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new OfflineError(e.message);
    }
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const msg = await res.json().then((j) => j.error).catch(() => null);
      throw new ApiError(res.status, msg);
    }
    return res.json();
  }

  state(since = 0) { return this.request(`/state?since=${since}`); }
  sync() { return this.request('/sync', { method: 'POST' }); }
  seed(body) { return this.request('/seed', { method: 'POST', body }); }
  deleteAccount() { return this.request('/account', { method: 'DELETE' }); }
}
