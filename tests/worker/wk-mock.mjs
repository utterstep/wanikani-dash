// Auxiliary miniflare worker: plays api.wanikani.com for the workerd tests. The main Worker's
// outbound fetches are routed here (vitest.config.mjs `outboundService`), so the Rust code needs
// no test hooks. Tests switch scenario via the WK_MOCK service binding: POST /__scenario/<a|b>.
import { fixtures } from '../fixtures/synthetic.js';
import { mockWk } from '../mock-api.js';

let scenario = 'a';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__scenario/')) {
      scenario = url.pathname.split('/')[2];
      return new Response(scenario);
    }
    const token = (request.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { status, body } = mockWk(fixtures(scenario))(request.url, token);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  },
};
