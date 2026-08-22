# WaniKani Dashboard

A static, no-build, no-backend stats dashboard for [WaniKani](https://www.wanikani.com).
Paste a read-only API token; it is stored in your browser only and requests go straight to `api.wanikani.com`.

**Charts:** SRS distribution · days per level (1–60) with median and projections · reviews per day · SRS promotions/demotions per day · upcoming reviews · accuracy by type · leeches.

## How review history works

WaniKani removed the `/reviews` endpoint, so per-day review counts and SRS movements are **derived locally**: every time you open the page it diffs `assignments` / `review_statistics` against the previous snapshot (IndexedDB) and records events. History starts the first time you open the dashboard and is per-browser. SRS moves are dated by the assignment's own timestamp; review counts land on the day you synced.

## Run locally

Any static server, e.g. `uv run python -m http.server 8000`, then open http://localhost:8000.

## Tests

`bash tests/e2e.sh` — runs in-browser unit tests (`tests/index.html`) and an end-to-end smoke test against a mocked API using [agent-browser](https://github.com/vercel-labs/agent-browser).

`scripts/record-fixtures.sh` records your real API responses into `tests/fixtures/real-*.json` (gitignored; reads `API_KEY` from `.env`). Open `index.html?mock=real` to drive the dashboard from them.
