# WaniKani Dashboard — Implementation Plan

## Context

Personal WaniKani stats dashboard. Empty project (`/Users/utterstep/my/japanese/wanikani-dash` contains only `.claude/` and a `.env` with `API_KEY` — never read into context, only `source`d in shell scripts).

Key API facts (verified against https://docs.api.wanikani.com/20170710/):
- CORS is enabled → **no backend**. Pure static HTML + ES modules + CSS, no build step.
- `GET /reviews` is **dead** (returns `[]`). Daily review counts and per-item SRS movements must be **derived from local snapshot diffs** of `assignments` + `review_statistics`. History starts on first open.
- `updated_after` filter + `If-Modified-Since`/ETag supported; 60 req/min; 500/page (subjects 1000/page).
- `assignments.data_updated_at` is bumped on each review → gives exact timestamp of the SRS stage change (used for dating ups/downs across visit gaps).

## Decisions (from interview)

| Topic | Decision |
|---|---|
| Architecture | Static, no build, no backend, ES modules, hand-rolled SVG charts, WK-style colors |
| History | IndexedDB snapshots diffed on each visit; raw per-item events kept forever |
| Attribution | SRS ups/downs dated by `assignments.data_updated_at`; review *counts* dated by fetch time (stats counters carry no timestamps — `review_statistics.data_updated_at` exists but only dates the last review of that item, so the count delta goes on fetch day) |
| Charts v1 | Days per level (1–60); daily reviews; SRS ups vs downs per day; leeches table; SRS distribution; accuracy by type; next-level + level-60 projection |
| Refresh | Auto on open (`updated_after`) + manual button; subjects cached permanently |
| UI | Single scrolling page, mobile-first, system dark mode + manual toggle |
| Key | Single key in localStorage; "forget key & wipe data" |
| Errors | 401 → open settings with message; 429 → wait `RateLimit-Reset`; offline → render last data with "stale since …" badge |
| Tests | In-browser test page (`tests/index.html`) + `agent-browser`; fixtures recorded from real API via shell script using `$API_KEY` |

## File layout

```
index.html              # dashboard shell: header, settings dialog, card/chart sections
styles.css              # WK palette tokens, light/dark, responsive grid, chart styles
js/
  main.js               # bootstrap: load key → load db → sync → compute → render
  api.js                # WK client: fetch w/ bearer, pagination, updated_after, 429 backoff, 401
  db.js                 # IndexedDB wrapper (idb-less, small promise helpers)
  sync.js               # orchestrates fetch → diff → persist events → update snapshot
  diff.js               # PURE: diffAssignments(prev,next) → SrsEvents; diffStats(prev,next) → review delta
  stats.js              # PURE: levelDurations, srsDistribution, accuracyByType, leechScore, projections, dailyAggregates
  charts.js             # PURE: svg string builders — barChart, stackedBarChart, timeline; tap/hover tooltip
  render.js             # DOM: cards, sections, leech table, settings UI, theme toggle
  theme.js              # prefers-color-scheme + localStorage override
tests/
  index.html            # loads tests/*.test.js, renders pass/fail list with data-testid
  harness.js            # tiny assert/describe/it, results to DOM + window.__results
  diff.test.js, stats.test.js, charts.test.js
  fixtures/             # recorded API JSON (gitignored) + small committed synthetic ones
  mock-api.js           # fetch() shim serving fixtures for e2e
  e2e.sh                # serves dir (python -m http.server via uv) and drives agent-browser
scripts/
  record-fixtures.sh    # source .env; curl all endpoints → tests/fixtures/*.json
.gitignore              # .env, tests/fixtures/real-*.json
docs/plans/wanikani-dash.md
```

## Data model (IndexedDB `wkdash`, version 1)

| Store | Key | Contents |
|---|---|---|
| `subjects` | `id` | slimmed subject: `{id, object, level, characters, slug, meanings[0], readings[primary], document_url, hidden_at}` |
| `assignments` | `subject_id` | last-seen `{subject_id, srs_stage, unlocked_at, started_at, passed_at, burned_at, available_at, data_updated_at}` |
| `review_statistics` | `subject_id` | last-seen counters `{meaning_correct, meaning_incorrect, reading_correct, reading_incorrect, meaning_current_streak, reading_current_streak, data_updated_at}` |
| `level_progressions` | `id` | raw `{level, unlocked_at, started_at, passed_at, completed_at, abandoned_at}` |
| `srs_events` | auto | `{subject_id, from, to, at (ISO from data_updated_at), seen_at}` — one per stage change |
| `review_events` | auto | `{at (fetch ISO), meaning_correct_d, meaning_incorrect_d, reading_correct_d, reading_incorrect_d, items}` — one per sync with nonzero delta |
| `meta` | `key` | `last_sync`, `updated_after` cursors per endpoint, `user` (level, started_at, subscription, current_vacation_started_at), `schema` |

localStorage: `wk_api_key`, `wk_theme`.

## Sync algorithm (`sync.js`)

1. `GET /user` (always) → level, vacation flag.
2. `GET /subjects?updated_after=<cursor>` (first run: full, ~10 pages w/ progress bar).
3. `GET /level_progressions` (small, full refetch).
4. `GET /assignments?updated_after=<cursor>` and `GET /review_statistics?updated_after=<cursor>`.
5. For each changed assignment: load prev from store; if `prev && prev.srs_stage !== next.srs_stage` → emit `srs_event{from, to, at: next.data_updated_at}`. If no prev (first run or newly unlocked) → no event.
6. Sum review_statistics deltas across changed rows; if any positive → one `review_event` at `now`. A review = meaning+reading answered; count reviews as `max(meaning_d, reading_d)` per item where `*_d = correct_d + incorrect_d` (radicals have no reading → meaning only).
7. Write new rows, advance cursors, set `last_sync`. All in one transaction per store; cursor advanced only after success.
8. First run has no prev → first snapshot only, zero events; UI shows "history starts today".

Derived-data caveat is shown once in UI ("Review history is collected locally from the day you first opened this page").

## Stats (`stats.js`, all pure functions on arrays)

- `levelDurations(progressions)` → `[{level, days, current, abandoned}]`; duration = `passed_at ?? now` − `unlocked_at`; abandoned rows shown hatched; vacation time not subtracted in v1 (note in UI).
- `srsDistribution(assignments, subjects)` → counts per group (apprentice 1–4, guru 5–6, master 7, enlightened 8, burned 9) × type.
- `accuracyByType(stats, subjects)` → meaning/reading % per radical/kanji/vocab.
- `leeches(stats, assignments, subjects)` → score = `incorrect / max(streak,1)^1.5` per meaning & reading, take max; exclude burned; threshold 1.0; sort desc; top 50.
- `dailySeries(events, days)` → `[{date, reviews, ups, downs}]` for last N days (default 90), gap days marked where no sync happened.
- `projection(progressions, currentLevel)` → median days/level over last 10 completed levels (ignore abandoned & current); `nextLevelEta = max(0, median − daysOnCurrent)`; `level60Eta = (60 − level) × median` from now. Shown as dates.

## Charts (`charts.js`)

String-returning SVG builders with `viewBox`, width 100%, CSS classes for colors. Tooltip: a single absolutely-positioned div; `pointerdown`/`pointermove` on bars (works for touch). Load `dataviz` skill before writing chart code for palette/axis rules.

- Level durations: vertical bars 1–60, current highlighted, median dashed line.
- Daily reviews: bars, 90 days, gaps hatched.
- Ups/downs: diverging stacked bars (ups up, downs down) colored by target SRS group.
- SRS distribution: horizontal stacked bars per type with WK colors (radical blue, kanji pink, vocab purple; apprentice→burned scale).

## UI (`index.html`, `render.js`)

Order: header (level badge, last sync, refresh, theme toggle, settings gear) → stat cards (level, days on level, next-level ETA, level-60 ETA, reviews today) → SRS distribution → level durations → daily reviews → ups/downs → accuracy → leeches table (char, type, level, meaning/reading wrong, streak, score, link to WK).

Settings `<dialog>`: API key input, "Save", "Forget key & wipe data" (confirm), "Export history JSON" (cheap to add; noted as optional).

## Error handling (`api.js`)

- 401 → throw `AuthError` → settings dialog opens with message.
- 429 → read `RateLimit-Reset`, sleep, retry once; then surface.
- Network error → `OfflineError` → `main.js` renders cached data + badge "offline, data from <last_sync>".
- Progress callback for first full load.

## Testing

- `tests/index.html` + `harness.js`: `describe/it/assertEqual`; each result rendered `<li data-status="pass|fail">`; `document.title` = `N passed / M failed`; `window.__done = true`.
- Unit tests on `diff.js`, `stats.js`, `charts.js` with synthetic fixtures (committed) and, when present, recorded real fixtures (gitignored `tests/fixtures/real-*.json`).
- `scripts/record-fixtures.sh`: `set -a; source .env; set +a; curl -H "Authorization: Bearer $API_KEY" …` for user, level_progressions, assignments, review_statistics, subjects (all pages) → `tests/fixtures/real-*.json`. Key never printed.
- `tests/e2e.sh`: `uv run python -m http.server` in background; `agent-browser open http://localhost:8000/tests/index.html`, wait for `li`, read `document.title`, fail if `failed > 0`; then open `index.html?mock=1` (main.js installs `mock-api.js` fetch shim when `?mock=1`), set key in localStorage, assert stat cards and chart SVGs render and that a second load with mutated mock data produces `srs_events`/`review_events` (verify via `agent-browser eval`).

## Verification

1. `bash tests/e2e.sh` → all unit tests pass, e2e assertions pass.
2. Manual: open `index.html` via local server on PC, paste real key, first load completes with progress; reload → fast; check iPhone via LAN, dark/light toggle.
3. After a real review session, reload → daily reviews and ups/downs reflect it.

## Out of scope (v1)

Multi-profile, cross-device sync, vacation-adjusted level durations, backend.
