# Cloud sync: server-side collection on Cloudflare

## Context

The dashboard keeps everything in the browser. The derived review history (`srs_events`, `review_events`, `syncs`, `history_since`) only exists in the one browser that collected it, so a second device starts from zero and the history only grows on days someone opens the page. Goal: both accounts (you and your wife, separate WK tokens) work from any device, with no server to administer.

Decisions from the interview:

| Topic | Decision |
|---|---|
| Collector | Cloudflare **Durable Object per WK account** (SQLite) polls WK on a self-re-armed **15-minute alarm**; browser also triggers a sync on open / ↻ (server-throttled to 1/min). Free plan: DO gets 30 s CPU per request, 100k req/day, 100k SQLite rows written/day; the plain Worker is limited to 10 ms CPU so it only routes. Exceeding free limits fails requests until midnight UTC, never bills. |
| Identity | Worker resolves the presented WK token → WK `user.id` (UUID) via `/user`, cached. DO is named by user id, so token rotation is automatic. Client never sends an id. |
| Hosting | Everything on Cloudflare: Worker static assets from `public/` + `/api/*`. Custom domain `wkdash.utterstep.app`, `workers_dev = false`. Deploy via **Workers Builds** git integration (push to main). |
| Access | Open to any valid WK token (no allowlist). |
| Migration | One browser per person holds real history: on first connect to an empty server account the app **asks** "upload this browser's history / start fresh". |
| Wipe | Two buttons: "Forget on this device" (local only) and "Delete account & history on server" (`DELETE /api/account`, confirm). |
| Local mode | Dropped. Browser no longer diffs; server is required. GH Pages root becomes a redirect stub to the new URL. |
| Layout | Site moves to `public/`; `wrangler.toml` + `package.json` at repo root (Workers Builds needs the config at the build root, so the node dev-deps live in the root `package.json`, not `worker/`). Node only via `pkgx npm` / `pkgx npx`. |
| Tests | Cloudflare vitest integration for Worker+DO in real workerd; existing in-browser unit tests + agent-browser e2e stay, driven by an in-page fake server that runs the real sync logic. |

## Architecture

```
browser (public/js)                      Cloudflare
┌────────────────────────┐    /api/*    ┌──────────────────────────────────────┐
│ main.js  boot/refresh  │ ───────────▶ │ worker/index.js  (10 ms CPU)         │
│ server.js /api client  │              │  auth: token → sha256 → Cache API    │
│ pull.js  state → IDB   │              │        miss → WK /user → user.id     │
│ db.js    IDB cache     │              │  env.ACCOUNT.getByName(userId)       │
│ api.js   WK (subjects, │              │        .fetch(request)  (streams)    │
│          summary only) │              │  else env.ASSETS.fetch(request)      │
└────────────────────────┘              └──────────────┬───────────────────────┘
        │ direct                                       │
        ▼                                              ▼
  api.wanikani.com                      worker/account.js  AccountDO (SQLite, 30 s CPU)
                                        │ sync(): WkApi + diff.js → tables     │
                                        │ alarm(): sync, re-arm +15 min        │
                                        │ routes: state / sync / seed / delete │
                                        └──────────────────────────────────────┘
```

Shared pure modules used by both sides: `public/js/api.js` (`WkApi`, works in workerd) and `public/js/diff.js` (`slim*`, `diffAssignments`, `diffStats`). Subjects (global, ~9k rows) and `/summary` (time-sensitive) stay browser-direct as today.

## Data model

### Durable Object SQLite (per account)

Generic row tables keep the schema tiny; `data` holds the same slim JSON the browser stores today.

```
meta(key TEXT PRIMARY KEY, value TEXT)
  token, user (json: id, username, level, started_at, current_vacation_started_at, subscription),
  cursors (json), history_since, last_sync, status ('empty'|'active'|'auth_failed'), next_sync_id
assignments(subject_id INTEGER PRIMARY KEY, sync_id INTEGER, data TEXT)
review_statistics(subject_id INTEGER PRIMARY KEY, sync_id INTEGER, data TEXT)
level_progressions(id INTEGER PRIMARY KEY, sync_id INTEGER, data TEXT)
srs_events(id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id INTEGER, dedupe TEXT UNIQUE, data TEXT)
   -- dedupe = `${subject_id}|${at}|${to}`; INSERT OR IGNORE
review_events(id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id INTEGER, data TEXT)
syncs(id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id INTEGER, data TEXT)   -- {at, srs_events, reviews}
```

`sync_id` is a per-account monotonic counter bumped once per sync run (and once for a seed). Every row written in that run carries it, which gives cheap incremental pulls (`since=<sync_id>`). Rows are never deleted.

### Browser IndexedDB (`wkdash`, stays version 1)

Same stores. Event/sync rows are now written with the **server id as explicit key** (`put(value, key)` on the existing autoIncrement stores) so re-pulls are idempotent. `meta` gains `server_version` (last pulled `sync_id`), `user.id`, `status`. Subjects and their cursor stay purely local. `localStorage.wk_api_key` unchanged.

## API (`/api/*`, `Authorization: Bearer <WK token>` on every call)

| Route | Behaviour |
|---|---|
| `GET /api/state?since=N` | `{account:{status, user, history_since, last_sync, version}, assignments, stats, progressions, srs_events, review_events, syncs}` with rows where `sync_id > N` (events/syncs include `id`). `status:'empty'` → arrays empty. |
| `POST /api/sync` | Runs a sync now unless one ran < 60 s ago or one is in flight (then awaits/returns that). First sync on an empty account bootstraps (full assignments/stats/progressions fetch: ≤ 38 subrequests, under the 50 limit). Returns `{ran, firstRun, srsEvents, reviews, version}`. Blocking; browser shows "Syncing on server…". |
| `POST /api/seed` | Only when `status:'empty'`. Body = browser export `{history_since, cursors, assignments, stats, srs_events, review_events, syncs}`. Stored under one `sync_id`, status → active, alarm armed. 409 otherwise. |
| `DELETE /api/account` | `storage.deleteAll()` + `deleteAlarm()`. |
| errors | 401 invalid token (from WK), 409 seed on non-empty, 502 `{error}` for WK/DO failures. |

The Worker never parses bodies: it forwards `request` to the DO stub with `stub.fetch(new Request(url, request))` after adding `X-WK-User` headers, so the 3 MB seed and state responses stream through under the 10 ms CPU cap.

**Auth in the Worker (`worker/auth.js`)**: `sha256(token)` → `caches.default.match('https://wkdash.internal/token/<hash>')` → hit gives `{id, username}`; miss → `WkApi(token).getOne('/user')` → 401 passes through; cache 1 h. Every DO request also compares the stored token with the presented one and replaces it when it differs (rotation).

**DO sync (`worker/sync.js`)**: port of today's `public/js/sync.js` steps 1–7 minus subjects/summary, against a small store object (`getMeta/setMeta/getMany/putAll/addEvents`). Order preserved: events first, then snapshot, then cursors. Wrapped in an in-memory promise lock so alarm and on-demand syncs never interleave. On WK 401 during a poll: `status:'auth_failed'`, alarm not re-armed; a request with a valid token for the same account re-activates. On any other error: log, re-arm alarm anyway.

The store interface has two implementations: SQLite (`worker/store-sqlite.js`) and in-memory (`tests/fake-server.js`), so the browser e2e can run the real sync code without wrangler.

## Browser flow (`public/js/main.js`)

1. No key → settings dialog (as today).
2. `model = loadModel(db)`; render cached immediately if present.
3. `GET /api/state?since=<server_version>`.
   - 401 → settings: "WaniKani rejected that API token."
   - `user.id` differs from local `meta.user.id` → wipe local (different account on this device), continue with `since=0`.
   - `status:'auth_failed'` → settings: "WaniKani rejected the token stored on the server; paste a fresh one." (Saving re-validates and resumes polling.)
   - `status:'empty'` and local has ≥ 1 sync and events → **seed dialog** ("This browser has history since <date>, N syncs. Upload it to the server / Start fresh"). Upload → `POST /api/seed` with local rows; fresh → nothing. Either way then `POST /api/sync`.
   - `status:'empty'`, no local history → `POST /api/sync` with status "First sync on server…".
4. Normal open: in parallel `POST /api/sync` (server throttles) and browser-direct `/subjects?updated_after` + `/summary` (existing `WkApi`, existing cursor logic moved from `sync.js`).
5. `GET /api/state?since` → `pull.js` merges rows into IDB, sets `server_version`; `loadModel` → `renderAll`. Status line as today ("+N reviews, M SRS changes since last sync" from the sync result).
6. ↻ = step 4–5. Offline → cached render with "Offline" status as today.

Settings dialog: token input; "Forget on this device" (localStorage + IDB); "Delete account & history on server" (confirm → `DELETE /api/account` → local wipe); "Export history" unchanged. Token save with a **different** token: no local wipe up front; step 3 decides by `user.id`.

## Files

**Move (git mv)**: `index.html`, `styles.css`, `js/` → `public/`. Update paths in `tests/index.html`, `tests/*.test.js` imports (`../js/` → `../public/js/`), `tests/e2e.sh`, README.

**New**
- `wrangler.toml` — name `wkdash`, `main = "worker/index.js"`, `[assets] directory="./public" binding="ASSETS" run_worker_first=["/api/*"]`, DO binding `ACCOUNT` → class `AccountDO` with SQLite storage (migration `new_sqlite_classes` or the `[exports]` form, whichever the installed wrangler accepts), `[[routes]] pattern="wkdash.utterstep.app" custom_domain=true`, `workers_dev=false`, `[vars] WK_API_BASE="https://api.wanikani.com/v2"`.
- `package.json` (root) — devDeps `wrangler`, `vitest`, Cloudflare vitest integration; scripts `dev`, `deploy`, `test` (vitest), `test:browser` (`bash tests/e2e.sh`). No runtime deps. `.gitignore` += `node_modules/`, `.wrangler/`.
- `worker/index.js` — fetch handler: `/api/*` → auth → DO stub fetch; else `env.ASSETS.fetch`. Exports `AccountDO`. When `env.MOCK_WK` is set, uses `makeFetch(fixtures(scenario))` from `tests/mock-api.js` as the WK fetch (scenario from `X-Mock-Scenario` header) so vitest never touches the network.
- `worker/auth.js` — `resolveUser(token, env)` as above.
- `worker/account.js` — `AccountDO`: table init, route handlers, `alarm()`, promise lock, `sync()` call, seed, delete.
- `worker/store-sqlite.js` — store interface over `ctx.storage.sql`.
- `worker/sync.js` — pure sync over the store interface using `../public/js/api.js` + `../public/js/diff.js`.
- `public/js/server.js` — tiny `/api` client (`state(since)`, `sync()`, `seed(body)`, `deleteAccount()`), throws `AuthError`/`OfflineError`/`ApiError` from `api.js`.
- `public/js/pull.js` — `applyState(db, state)` (IDB merge with explicit keys), `collectSeed(db)` (local rows → seed body), `loadModel` (moved from sync.js).
- `public/js/local.js` — browser-direct `/subjects` + `/summary` refresh (the two steps kept from old `sync.js`).
- `index.html` (root) — redirect stub for GH Pages: `<meta http-equiv="refresh">` + `location.replace('https://wkdash.utterstep.app' + location.search + location.hash)`, comment explaining why it exists.
- `tests/fake-server.js` — in-page fake `/api` for `?mock=`: in-memory store + real `worker/sync.js` + `worker/auth`-equivalent token check via `makeFetch`; exposes `window.__mock.scenario('b')`.
- `tests/worker/*.test.js` (vitest, workerd) — see Testing.
- `docs/plans/cloud-sync.md` — this plan (interview Phase 4; written first thing after approval).

**Modified**
- `public/js/main.js` — new boot/refresh flow, seed dialog, two wipe buttons, mock installs both WK shim and fake server.
- `public/js/db.js` — `putAllKeyed(store, rows, keyOf)`, unchanged schema.
- `public/js/sync.js` — deleted (split into `pull.js` / `local.js` / `worker/sync.js`).
- `public/index.html` — settings dialog: seed dialog markup, "Forget on this device", "Delete account & history on server", note text ("token is sent to wkdash.utterstep.app, which polls WaniKani for you every 15 minutes").
- `public/js/render.js` — header "synced <server last_sync>"; history note wording ("collected on the server since …, every 15 min").
- `tests/fixtures/synthetic.js` — add `id` (UUID) to the user fixture (real WK has `data.id`; auth keys on it).
- `tests/sync.test.js` → replaced by `tests/pull.test.js` (applyState idempotent, since handling, collectSeed round-trip) and the worker vitest suite.
- `tests/e2e.sh` — keep python http.server for repo root (unit tests + `public/index.html?mock=a` with fake server); scenarios: first sync (empty account, no local history → bootstrap message), seed dialog when local history exists (upload + start-fresh), scenario b events via `__mock.scenario('b')` + ↻, bad key, server-delete.
- `README.md` — new architecture, deploy steps, dev commands (`pkgx npm install`, `pkgx npx wrangler dev`, `pkgx npx vitest`).
- `scripts/record-fixtures.sh` — unchanged except output path stays `tests/fixtures/`.

## One-time setup you do in the Cloudflare dashboard (not code)

1. Workers & Pages → Create → connect `utterstep/wanikani-dash`, root `/`, build command empty, deploy command default (`npx wrangler deploy`). First deploy creates the DO class and the `wkdash.utterstep.app` DNS record in the `utterstep.app` zone.
2. Open the site in your main browser → seed dialog → Upload. Your wife does the same from hers.
3. Optionally disable GH Pages later (the stub keeps redirecting meanwhile).

## Testing

- **Worker (vitest in workerd, `MOCK_WK=1`)**: 401 for bad token; `state` on empty account; `seed` then `state` returns seeded rows and `409` on second seed; `sync` bootstrap from scenario a (no events) then scenario b via header → 4 srs events, 1 review event, cursors advanced, `since` pull returns only new rows; srs-event dedupe on re-run; throttle (second `sync` within 60 s → `ran:false`); alarm armed after sync (`ctx.storage.getAlarm()` via `runInDurableObject`) and alarm handler re-arms; poll 401 → `auth_failed`, then valid token reactivates; token rotation keeps the same account; `DELETE` empties storage and alarm.
- **Browser unit (tests/index.html)**: existing diff/stats/charts/kanken suites; new `pull.test.js`.
- **e2e (`bash tests/e2e.sh`)**: scenarios above, screenshots as today.
- **Manual**: `pkgx npx wrangler dev` with real token on phone + laptop (LAN), then push to main and verify the custom domain, the 15-min alarm (last_sync advances without opening the page), and that the old GH Pages URL redirects.

---

## Outcome (2026-09-02)

Implemented as planned, with these deviations:

- The account logic is split into `worker/account-core.js` (runtime-independent: routing, throttle, seed, delete, promise lock) and `worker/account.js` (the Durable Object: SQLite store, alarms). The same core runs in-page in `tests/fake-server.js` over `tests/store-memory.js`, so `tests/e2e.sh` needs no wrangler — only `uv` and agent-browser. The e2e's fake server persists to `localStorage` across reloads and uses a zero throttle so "reload with scenario b" plays the role of "the alarm fired".
- The status line after a pull reports either the sync just triggered (`ran: true`) or, when throttled, the events pulled since this browser last looked.
- `?legacy=1` (mock mode only) injects pre-server IndexedDB history to exercise the seed dialog.
- Worker tests use `@cloudflare/vitest-plugin` (successor of vitest-pool-workers) with `MOCK_WK=1`; a GitHub Actions workflow runs them on every push so Node never has to run locally. `package.json` pins `@rolldown/binding-darwin-arm64` as an optional dependency because npm under pkgx skipped the native binding.
- SQLite `rowsWritten` counts index writes, so inserted-row counts use `SELECT changes()`.

Verification: `pkgx npx vitest run` → 5 passed; `bash tests/e2e.sh` → 50 unit tests passed, all e2e scenarios OK; `wrangler deploy --dry-run` bundles cleanly (43.6 KiB, bindings ACCOUNT / ASSETS / WK_API_BASE). Not yet done: connecting the repo in the Cloudflare dashboard and the first real deploy.

## Outcome, part 2 (2026-09-02, later the same day)

Two follow-ups after the first implementation:

1. **Migration bug.** IndexedDB and localStorage are per origin, so an in-app "upload this
   browser's history" dialog on the new domain could never see history collected under
   `utterstep.github.io`. The root `index.html` (still served by GitHub Pages, same origin as the
   old data) is now the migration page: it reads the old IndexedDB, offers upload / skip, POSTs
   the seed cross-origin to `https://wkdash.utterstep.app/api/seed` (Worker allows that one
   origin via `ALLOWED_ORIGINS`), then redirects. The in-app dialog was removed.
2. **Server rewritten in Rust (`workers-rs`).** Workspace `crates/wkdash-core` (runtime-free:
   models, diff, WK client over a `Transport` trait, `Store` trait with `MemStore`, sync/seed,
   `Account` routing with `Runtime` trait, CORS) and `crates/wkdash-worker` (Worker entry,
   SQLite `Store`, `AccountDO` with alarms, Cache API auth). Same `/api` contract as before, so
   the browser did not change. JS server code survives only as `tests/reference/`, the contract
   double behind the in-page fake server used by the browser e2e.

Findings along the way:

- Cloudflare's Workers Builds image has no `cargo`; deploys moved to GitHub Actions
  (`cloudflare/wrangler-action`, secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).
- `worker-build`'s abort handler needs the wasm `target_features` section; `strip = true` in
  the release profile removes it ("externref table required for catch wrappers").
- This `@cloudflare/vitest-plugin` has no `fetchMock`; the workerd suite routes the Worker's
  outbound fetches to an auxiliary miniflare worker (`tests/worker/wk-mock.mjs`) instead, so
  the Rust code carries no test hooks.
- Responses returned by a Durable Object stub are immutable; CORS headers are added by
  rebuilding the response around the same body stream.

Verification: `cargo nextest run` 8 passed; `cargo clippy --all-targets -D warnings` (native and
wasm32) clean; `pkgx npx vitest run` against the built wasm: 6 passed; `bash tests/e2e.sh`:
50 unit tests + all e2e scenarios OK; `wrangler deploy --dry-run` bundles (748 KiB, 253 KiB gzip).
