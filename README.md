# WaniKani Dashboard

A no-build stats dashboard for [WaniKani](https://www.wanikani.com), served from Cloudflare at
[wkdash.utterstep.app](https://wkdash.utterstep.app). Paste a read-only API token once; a
Cloudflare Worker polls WaniKani for you every 15 minutes, so the review history keeps growing
and every device shows the same dashboard.

**Charts:** SRS distribution · days per level (1–60) with median and projections · reviews per day · SRS promotions/demotions per day · upcoming reviews · Kanken coverage heat map · accuracy by type · leeches.

## How it works

```
browser (public/)                          Cloudflare
  main.js  ── /api/* ──────────────▶  crates/wkdash-worker   Rust → wasm. token → WK user id (cached)
  IndexedDB cache                      └─ AccountDO           one SQLite Durable Object per WK account:
  subjects + /summary straight            snapshot (assignments, review stats, progressions)
  from api.wanikani.com                   derived history (srs_events, review_events, syncs)
                                          alarm every 15 min → crates/wkdash-core (sync + diff)
```

- **Identity is the WaniKani account, not the token.** The Worker resolves the token via WK
  `/user` and keys storage by the account's id, so rotating the token just works: paste the new
  one and the same dashboard opens. The stored token is replaced on the server.
- **History is derived server-side.** WaniKani has no `/reviews` endpoint any more, so every
  poll diffs `assignments` / `review_statistics` against the previous snapshot and records SRS
  moves (dated by WaniKani's own timestamp) and review counts (dated by the poll). Opening the
  page or pressing ↻ also triggers a poll (throttled to once a minute server-side).
- **The browser only caches.** `/api/state?since=<version>` pulls what changed; IndexedDB makes
  the page render instantly and work offline. Subjects (global) and `/summary` (time-sensitive)
  are still fetched directly from WaniKani by the browser.
- **Migrating a browser that collected history under the old GitHub Pages URL:** storage is per
  origin, so the old page (`index.html` at the repo root, still served by GitHub Pages) reads
  that browser's IndexedDB itself and offers to upload it to the new server before redirecting.
- **Settings:** *Forget on this device* clears only this browser. *Delete account & history on
  server* removes the Durable Object's storage and stops polling (token-authenticated).
- **Free tier:** two accounts at 15-minute polling use a few hundred of the 100k daily Durable
  Object requests. If a limit were ever exceeded, requests fail until the daily reset; the free
  plan never bills.

The server is Rust (`workers-rs`): `crates/wkdash-core` holds all logic behind `Store`,
`Transport` and `Runtime` traits and is tested natively with `cargo nextest`;
`crates/wkdash-worker` is the thin Cloudflare glue (SQLite store, alarms, Cache API, assets).
The JSON contract of `/api` is described in `docs/plans/cloud-sync.md`.

## Kanken coverage

Pick a 漢検 level and the dashboard draws every kanji it asks for, one cell per kanji,
coloured by where that kanji sits in your WaniKani SRS — burned, enlightened, master,
guru, apprentice, waiting in your lessons, still locked, or not taught by WaniKani at
all. Cells are ordered by WaniKani level, so the coloured front edge shows how far your
levels reach into each school grade. On touch screens the first tap on a cell shows its
tooltip and the second opens it on WaniKani; on small screens the per-grade grids start
collapsed, with the summary strips always visible.

The Jōyō grade table is embedded (`public/js/kanji-grades.js`, ~10 kB, from
[KANJIDIC2](https://www.edrdg.org/kanjidic/kanjd2index_legacy.html) © EDRDG, CC BY-SA 4.0),
so the view needs no network of its own. Regenerate it with:

```sh
npm pack kanjidic2-json && tar xzf kanjidic2-json-*.tgz
node scripts/build-kanji-grades.mjs package/KANJIS.json
```

The script refuses to write unless the source carries the 2017 kyōiku revision
(1026 kanji in grades 1–6, prefecture kanji in grade 4, 2136 Jōyō in total).

**How far Jōyō grades take you.** 漢検 10級–5級 are *exactly* 小学1年–6年 of the
学年別漢字配当表, and 2級 is the whole 常用漢字表 — those seven levels are pinned down
by the grade data alone. 4級 / 3級 / 準2級 subdivide the 1,110 secondary-school Jōyō
kanji into 313 / 284 / 328, on a list the 日本漢字能力検定協会 publishes separately;
grades cannot recover it, so those three appear greyed out in the picker rather than
being guessed at. 準1級 (~3,000 kanji) is offered as an approximation: Jōyō + Jinmeiyō,
2,999 kanji.

## Deploy

GitHub Actions builds and deploys on every push to `main` (`.github/workflows/test.yml`):
fmt, clippy, `cargo nextest`, the wasm build, the workerd suite, then `wrangler deploy`.
One-time setup:

1. Create a Cloudflare API token (template "Edit Cloudflare Workers") and add it to the repo
   as `CLOUDFLARE_API_TOKEN`, plus your account id as `CLOUDFLARE_ACCOUNT_ID`.
2. Push to `main`. The first deploy creates the `AccountDO` class and the
   `wkdash.utterstep.app` custom domain (the zone must already be in the account).
3. Visit the old GitHub Pages URL in the browser that holds your history and choose *Upload*.

Cloudflare's own Workers Builds cannot be used directly: its build image has no `cargo`.
If you prefer it anyway, set its build command to install rustup first
(`curl https://sh.rustup.rs -sSf | sh -s -- -y -t wasm32-unknown-unknown && . "$HOME/.cargo/env" && cargo install worker-build`)
and its deploy command to `. "$HOME/.cargo/env" && npx wrangler deploy`; expect several minutes per build.

`wrangler.toml` is the whole configuration; `workers_dev` is off.

## Develop

Rust only, for the server:

```sh
cargo nextest run                                   # core logic, natively
cargo clippy --all-targets -- -D warnings
cargo install worker-build                          # once
cd crates/wkdash-worker && worker-build --release   # → build/worker/shim.mjs + wasm
```

Node is needed only to run the built Worker locally or in workerd tests; use
[pkgx](https://pkgx.sh) so nothing is installed globally:

```sh
pkgx npm install                  # once (node_modules/ is gitignored)
pkgx npx wrangler dev             # builds via worker-build, serves http://localhost:8787
pkgx npx vitest run               # the built Worker + Durable Object in workerd, WaniKani mocked
```

For the page alone any static server works: `uv run python -m http.server 8000`, then open
http://localhost:8000/public/index.html?mock=a — in `?mock=` mode the `/api` is faked in-page
by `tests/fake-server.js`, a JS double of the account logic (`tests/reference/`) over an
in-memory store. **The double must be kept in sync with the Rust server.** The Rust tests
write `tests/fixtures/golden-state.json` (`UPDATE_GOLDEN=1 cargo nextest run`) and the browser
suite asserts the double produces the identical `/api/state` for the same scenario, so a
contract change on one side fails the other until it is ported.

## Tests

- `cargo nextest run` — diff, CORS, and the whole account flow (bootstrap, throttle, alarm
  re-arm, incremental state, seed, delete, token rotation, revoked token) over the in-memory
  store with the shared JSON fixtures. No Node.
- `pkgx npx vitest run` — the built wasm Worker in a real workerd: assets, CORS, auth, the DO
  lifecycle including a real alarm. Runs in CI on every push, so it never has to run locally.
- `bash tests/e2e.sh` — in-browser unit tests (`tests/index.html`: diff, stats, charts, kanken,
  pull, and the JS reference account logic) plus an end-to-end run of the page against the
  in-page fake server with [agent-browser](https://github.com/vercel-labs/agent-browser):
  first sync, reopening after the server collected more, bad token, the old-origin migration
  page (upload, refusal over an existing account, no-history forward), and server-side delete.
  Needs only `uv` and `agent-browser`.

`tests/fixtures/synthetic.js` is the source of the fixtures; `synthetic-{a,b}.json` are its
export for the Rust tests (regenerate with the one-liner in `scripts/export-fixtures.sh`).
`scripts/record-fixtures.sh` records your real API responses into `tests/fixtures/real-*.json`
(gitignored; reads `API_KEY` from `.env`). Open `public/index.html?mock=real` to drive the
dashboard from them.
