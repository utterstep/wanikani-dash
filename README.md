# WaniKani Dashboard

A static, no-build, no-backend stats dashboard for [WaniKani](https://www.wanikani.com).
Paste a read-only API token; it is stored in your browser only and requests go straight to `api.wanikani.com`.

**Charts:** SRS distribution · days per level (1–60) with median and projections · reviews per day · SRS promotions/demotions per day · upcoming reviews · Kanken coverage heat map · accuracy by type · leeches.

## Kanken coverage

Pick a 漢検 level and the dashboard draws every kanji it asks for, one cell per kanji,
coloured by where that kanji sits in your WaniKani SRS — burned, enlightened, master,
guru, apprentice, waiting in your lessons, still locked, or not taught by WaniKani at
all. Cells are ordered by WaniKani level, so the coloured front edge shows how far your
levels reach into each school grade. On touch screens the first tap on a cell shows its
tooltip and the second opens it on WaniKani; on small screens the per-grade grids start
collapsed, with the summary strips always visible.

The Jōyō grade table is embedded (`js/kanji-grades.js`, ~10 kB, from
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

## How review history works

WaniKani removed the `/reviews` endpoint, so per-day review counts and SRS movements are **derived locally**: every time you open the page it diffs `assignments` / `review_statistics` against the previous snapshot (IndexedDB) and records events. History starts the first time you open the dashboard and is per-browser. SRS moves are dated by the assignment's own timestamp; review counts land on the day you synced.

## Run locally

Any static server, e.g. `uv run python -m http.server 8000`, then open http://localhost:8000.

## Tests

`bash tests/e2e.sh` — runs in-browser unit tests (`tests/index.html`) and an end-to-end smoke test against a mocked API using [agent-browser](https://github.com/vercel-labs/agent-browser).

`scripts/record-fixtures.sh` records your real API responses into `tests/fixtures/real-*.json` (gitignored; reads `API_KEY` from `.env`). Open `index.html?mock=real` to drive the dashboard from them.
