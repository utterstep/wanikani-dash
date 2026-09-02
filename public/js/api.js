// WaniKani API v2 client. Browser-only (CORS enabled by WK).

export const API_BASE = 'https://api.wanikani.com/v2';

export class AuthError extends Error { constructor(msg = 'Invalid API key') { super(msg); this.name = 'AuthError'; } }
export class OfflineError extends Error { constructor(msg = 'Network unavailable') { super(msg); this.name = 'OfflineError'; } }
export class ApiError extends Error { constructor(status, msg) { super(msg || `HTTP ${status}`); this.name = 'ApiError'; this.status = status; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WkApi {
  /**
   * @param {string} token
   * @param {{fetch?: typeof fetch, base?: string, onProgress?: (info:object)=>void}} opts
   */
  constructor(token, opts = {}) {
    this.token = token;
    this.fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.base = opts.base ?? API_BASE;
    this.onProgress = opts.onProgress ?? (() => {});
  }

  async request(url, { retried = false } = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Wanikani-Revision': '20170710',
        },
      });
    } catch (e) {
      throw new OfflineError(e.message);
    }
    if (res.status === 401) throw new AuthError();
    if (res.status === 429 && !retried) {
      const reset = Number(res.headers.get('RateLimit-Reset'));
      const waitMs = reset ? Math.max(1000, reset * 1000 - Date.now()) : 60_000;
      this.onProgress({ kind: 'ratelimit', waitMs });
      await sleep(Math.min(waitMs, 90_000));
      return this.request(url, { retried: true });
    }
    if (!res.ok) throw new ApiError(res.status);
    return res.json();
  }

  /** Single resource (e.g. /user). */
  async getOne(path) {
    return this.request(`${this.base}${path}`);
  }

  /**
   * Collection with pagination. Follows pages.next_url.
   * @param {string} path e.g. '/assignments'
   * @param {Record<string,string>} params
   * @returns {Promise<object[]>} flat list of resources
   */
  async getAll(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    let url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const out = [];
    let page = 0;
    while (url) {
      const body = await this.request(url);
      out.push(...body.data);
      page += 1;
      this.onProgress({ kind: 'page', path, page, loaded: out.length, total: body.total_count });
      url = body.pages?.next_url ?? null;
    }
    return out;
  }
}
