import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs the built Rust Worker (crates/wkdash-worker/build, from `worker-build --release`) in workerd.
// Every outbound fetch of the Worker (i.e. api.wanikani.com) is routed to tests/worker/wk-mock.mjs.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        outboundService: 'wk-mock',
        serviceBindings: { WK_MOCK: 'wk-mock' },
        workers: [{
          name: 'wk-mock',
          compatibilityDate: '2026-08-01',
          modulesRoot: 'tests',
          modules: [
            { type: 'ESModule', path: 'tests/worker/wk-mock.mjs' },
            { type: 'ESModule', path: 'tests/mock-api.js' },
            { type: 'ESModule', path: 'tests/fixtures/synthetic.js' },
          ],
        }],
      },
    }),
  ],
  test: { include: ['tests/worker/**/*.test.js'] },
});
