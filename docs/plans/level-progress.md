# Level progress view — Implementation Plan

## Context

The dashboard shows *how fast* levels go but nothing about *where the current level stands*:
which radicals/kanji/vocab sit at which SRS stage, how close the level is to the 90%-of-kanji
threshold, when the level-up can happen at the earliest, and how this level compares to the
previous one. All data is already in the browser; the only gaps are `component_subject_ids`
(which radicals gate a locked kanji) and the radical image URL, both dropped by `slimSubject`.

**No server change.** Subjects are fetched by the browser (`public/js/local.js`); the Rust
worker never reads subjects and `/api/state` is untouched, so golden fixtures, `tests/reference/`
and `tests/worker/` stay as they are.

## Decisions (from interview)

| Topic | Decision |
|---|---|
| Content | Item grid (radicals / kanji / vocab cells coloured by SRS, Kanken-style) + passed/needed counters + earliest-possible **and** at-your-pace ETA + cumulative kanji-passed timeline |
| Level scope | `<select>` of levels 1..current, defaults to `user.level` on every load (not persisted) |
| Placement | New panel directly after the summary cards |
| Gates | Add `components` (kanji) and `image` (radicals without characters) to `slimSubject`; one-time subjects re-download via a schema marker |
| ETA | Earliest: lessons now, every review at `available_at`, hour truncation, accelerated ladder for level-1/2 subjects. Pace: same chain with measured lesson lag and review-lag factor. Vacation → paused |
| Grid | Grouped by type with strip summaries (collapsible ≤600px like Kanken); most-learned first; due-now ring; bottleneck-kanji ring |
| Image radicals | `<img>` from WaniKani `character_images` (SVG); radical name text on load error |
| Timeline | Step line: cumulative kanji passed vs days since level unlock, threshold line, previous level faint. New `stepChart` |
| Cards | 'Next level' card sub-line becomes `earliest <date> · N kanji to go` |

## WaniKani facts the logic relies on (verified in API docs)

- Level-up: ≥90% of the level's kanji *passed* (`passed_at` set). Needed = `n − floor(n/10)` (float-safe `ceil(0.9n)`).
- Kanji unlock when all `component_subject_ids` radicals are passed; radicals unlock at level start.
- After a review landing on stage `s`: `available_at = floor_to_hour(review_time + interval[s])`.
- Intervals: stage 1 4h, 2 8h, 3 23h, 4 47h; accelerated (subjects on levels 1–2): 2h, 4h, 8h, 23h.
- `character_images`: `[{url, content_type: 'image/svg+xml', metadata: {inline_styles: true}}]`, cdn.wanikani.com, fine in `<img>`.

## Data changes (browser only)

`public/js/diff.js` `slimSubject` gains `components` (kanji: `component_subject_ids`, else `null`) and
`image` (radical with `characters == null`: URL of the first `image/svg+xml` entry, else `null`).

`public/js/local.js` `refreshLocal`: `SUBJECTS_SCHEMA = 2`; if `meta.subjects_schema !== 2` →
clear `subjects`, drop `cursors.subjects`, full fetch (existing progress bar), set the marker.
IndexedDB version stays 1. `tests/mock-api.js` `injectLegacyHistory` seeds subjects directly → set the marker there too.

## Architecture

```
public/js/level.js   NEW  pure: items, needed, ETA chains, lags, timeline
public/js/charts.js  +stepChart()
public/js/render.js  +renderLevel(); renderCards() uses the earliest ETA
public/index.html    +panel after #cards; main.js wires #level-select
```

### `public/js/level.js`

```js
export const HOUR = 3_600_000;
export const LADDERS = { default: [0, 4, 8, 23, 47].map(h => h * HOUR), accelerated: [0, 2, 4, 8, 23].map(h => h * HOUR) }; // index = stage entered
export const LEVEL_STATES = KANJI_STATES.filter((s) => s.key !== 'absent');      // kanken.js: burned … locked
export function ladderFor(subjectLevel)                                          // ≤2 → accelerated
export function neededKanji(total)                                               // total - floor(total/10)
export function progressionFor(progressions, level)                              // latest non-abandoned with unlocked_at, else latest, else null
export function isPassed(asg, progression)                                       // srs_stage>=5 || (passed_at && (!prog || passed_at >= prog.unlocked_at))
export function levelItems(level, subjects, assignmentsById, now, progression)   // → LevelItems
export function afterStage(t, stage, ladder, { factor = 1, floor = true })       // time the item reaches stage 5 having entered `stage` at t
export function passTimes(kanji, ctx, { lessonLagMs = 0, factor = 1, floor = true }) // → Map<id, PathItem>
export function measureLags(subjects, assignmentsById, progressions, { window = 3 })  // → Lags
export function levelUpEta(items, ctx, lags)                                     // → Eta
export function levelTimeline(level, progressions, subjects, assignmentsById, now) // → Timeline
```

```
Item       { id, type, characters, image, meaning, reading, url, level, state, srs_stage|null, passed, dueNow, available_at, components|null }
LevelItems { level, groups: {radical, kanji, vocabulary: Item[]}, counts: {type → {state → n}},
             kanji: {passed, total, needed}, radicals: {passed, total} }
PathItem   { id, at: ms|Infinity, locked, unlockAt|null, gateRadical|null }
Eta        { needed, passed, remaining, reason: null|'vacation'|'passed'|'blocked',
             earliest: {at: Date|null, bottleneck: id[], lessonsNow}, pace: {at: Date|null, bottleneck: id[]}, lags }
Lags       { lessonLagMs, factor, samples: {lesson, review} }
Timeline   { threshold, series: [{ key: 'current'|'previous', level, endX, points: [{x: days, y, characters}] }] }
ctx        { subjectsById, assignmentsById, user, now, progression }
```

Rules:
- `levelItems`: `subject.level === level`, skip `hidden_at`; `normType`. **Unlocked** = assignment exists, `!hidden`, `unlocked_at != null` (WK returns locked assignments with `unlocked_at: null`). State = unlocked ? `stateOfStage(srs_stage)` : `'locked'`. `dueNow` = unlocked, stage 1–8, `available_at ≤ now`. `passed` = unlocked && `isPassed` (a demoted Guru kanji still counts, as on WK; a `passed_at` older than the current progression does not). Sort: `LEVEL_STATES` index, stage desc, id.
- `afterStage`: `while (s < 5) { t = floor ? floorHour(t + ladder[s] * factor) : t + ladder[s] * factor; s++ }`. Ladder by the **subject's** level. Only the first hop is off-hour, so per-hop flooring is exact.
- `passTimes` (memoised `passOf(id)` over the level's kanji and radicals reachable via `components`): passed → `now`; unlocked stage 0 → chain from `now + lessonLagMs` at stage 1; stage 1–4 → chain from `max(available_at ?? now, now)` at `stage + 1`; locked kanji → `unlockAt = max(passOf(radical))` (`gateRadical` = argmax; missing subject skipped; `Infinity` propagates) then chain from `unlockAt + lessonLagMs`; locked radical → `Infinity`.
- `levelUpEta`: vacation → `'vacation'`; `k = needed − passed ≤ 0` → `'passed'`; else `passTimes` twice (earliest `{0, 1, floor}`; pace `{lags…, floor:false}`), sort pending by `at` then id, `at = k-th`, `Infinity` → `'blocked'`; `bottleneck` = pending with `at === k-th`; `lessonsNow` = stage-0 unlocked items among the first k. Level 60: the UI hides the ETA cards; no special reason.
- `measureLags`: latest `window` completed progressions; per progression, that level's kanji with assignment `unlocked_at >= p.unlocked_at`. Lesson lag = median(`started_at − unlocked_at`, ≥0), fallback 0. Factor = `max(1, median((passed_at − started_at) / Σ ladderFor(sub.level)[1..4]))`, fallback 1. `samples` lets the UI say "based on N kanji" or hide the pace date when there are none.
- `levelTimeline`: progression = `progressionFor`; kanji with `isPassed`, `x = max(0, daysBetween(unlocked_at, passed_at))`, sorted, cumulative; starts at `(0,0)`; `endX` = days to `passed_at ?? now`. Previous = `level − 1` the same way, omitted without a progression. Y = absolute count; threshold = current level's `needed`.

### `charts.js` — `stepChart(series, opts)`

`stepChart([{cls, points:[{x,y,tip}], endX, muted}], { title, width, height=200, threshold?: {value,label} })`.
Same pads/viewBox/`niceTicks`/`.grid`/`.tick`/`.ref` conventions as `columnChart`. Per series a
`<path class="line {cls}">` (`M x0,y0 H x1 V y1 …` to `endX`) and one `<g class="hit" data-tip>`
with a `<circle class="dot {cls}">` per point. X ticks labelled `Nd`.

### `render.js` — `renderLevel(model, now)`

Panel after `#cards`: `.panel-head` with `<h2>Level progress</h2>` + `<select id="level-select">` (1..`user.level`).
1. `mini()` cards: *Kanji passed* `p / needed` (sub `of N · 90% to level up`), *Radicals* `p / n`, *Earliest level-up* date+time (sub `if every review is on time · N lessons now`), *At your pace* date (sub `lessons ~Xh late, reviews ×F` or hidden when `samples` are 0). Reason text replaces the two ETA cards: vacation → "paused — on vacation"; passed / past level → "passed <date> in N days"; blocked → "waiting for locked radicals"; level 60 → no ETA cards.
2. Three `<details class="heat-grade">` (Radicals / Kanji / Vocabulary), `open` on >600px, `strip()` in the summary, `.heat-grid` of `.heat.st-*` cells reused from Kanken. Cell content: characters, else `<img class="radical-img" src=image alt=meaning>` with `onerror` swapping to the name text. `.due` ring for due-now items, `.bottleneck` ring for `earliest.bottleneck`. Tooltip: name · stage · "due now" / next review · "sets the level-up date" / "unlocks after <radical>". Cells link to `document_url`.
3. `stepChart`: current series (`level-current`) + previous (`level`, muted), threshold `needed`; note "Level N unlocked <date>; grey line is level N−1."
4. `renderCards`: 'Next level' sub-line `earliest <fmtDate> · N kanji to go` when `eta.earliest.at` exists, else the current text. `renderAll` computes the current-level ETA once and passes it to both.

`main.js`: `#level-select` change → `renderAll(model, { level })` (transient, in-memory).

`styles.css`: `.chart .line { fill:none; stroke-width:2 }`, `.line.level-current/.dot.level-current`, `.line.level`, `.line.muted { opacity:.4 }`; `.heat.due { outline: 2px solid var(--reviews) }`; `.heat.bottleneck { box-shadow: inset 0 0 0 3px var(--kanji) }`; `.radical-img { width:70%; filter:invert(1) }` on filled cells only (no invert on locked/lesson; invert again in dark theme); `.heat-text { font-size: 9px }`.

## Files

| File | Change |
|---|---|
| `public/js/level.js` | **new** |
| `public/js/diff.js` | `slimSubject`: `components`, `image` |
| `public/js/local.js` | subjects schema marker → one-time re-download |
| `public/js/charts.js` | `stepChart` |
| `public/js/render.js` | `renderLevel`, card sub-line |
| `public/js/main.js` | wire `#level-select` |
| `public/index.html`, `public/styles.css` | panel markup, styles |
| `tests/fixtures/synthetic.js` | `component_subject_ids` on base kanji (→ [1]), `character_images` on radical 1 (keeps characters → `image` null); new exported `levelFixture()` |
| `tests/fixtures/synthetic-{a,b}.json` | regenerate via `scripts/export-fixtures.sh` (Rust ignores the new fields) |
| `tests/level.test.js` | **new**; register in `tests/index.html` |
| `tests/charts.test.js`, `tests/diff.test.js` | `stepChart`, `slimSubject` |
| `tests/mock-api.js` | set `subjects_schema` in `injectLegacyHistory` |
| `tests/e2e.sh` | chart count 5 → 6; level block |
| `README.md` | charts list + a paragraph on the ETA assumptions |

## Testing

**Fixture** `levelFixture()` (slim rows, user level 4, `NOW_A`), separate because `fake-server.test.js` and `kanken.test.js` pin the base fixture's counts:
- radicals: 10 (level 4, `characters: null`, SVG image, stage 4, `available_at NOW+3h`), 11 (level 4, passed), 1 (level 1, burned).
- kanji level 4: 20 stage 0; 21 stage 3 available `NOW−1h` (due); 22 stage 4 available `NOW+5h`; 23 locked, components [10, 11]; 24 locked, components [1]; 25 passed; 26 demoted (stage 2, `passed_at` inside the progression); 27 stale reset row (`passed_at` before the progression); 28 hidden.
- vocab 30 + kana_vocabulary 31.
- progressions 1–3 completed, level 4 abandoned at −12d, fresh run at −5d; level 2–3 kanji timestamps giving lesson-lag median 6h and factor 1.5.

**Unit** (`tests/level.test.js`):
1. `neededKanji`: 10→9, 32→29, 70→63, 0→0.
2. `afterStage`: 10:20 start, default ladder → exact ISO; accelerated 37h; `floor:false, factor:2`.
3. `levelItems`: groups {2, 8, 2}; kana folded; hidden excluded; locked 2; `dueNow` only 21; 26 apprentice+passed; 27 not passed; `needed 8`, `passed 2`; radicals 1/2; sort order.
4. `passTimes` + `levelUpEta`: 22 → `available_at`; 21 → `floorHour(now+47h)`; 23 → `unlockAt` = radical 10's pass time, `gateRadical 10`; 24 → `unlockAt === now`; `remaining 6`; order `[22, 21, 20, 24, 27, 23]`; `at` = 6th; bottleneck; `lessonsNow`; `pace.at > earliest.at`.
5. Guards: vacation; all passed; radical 10 `unlocked_at: null` → `'blocked'`.
6. `measureLags` + `progressionFor`: exact medians; no completed levels → `{0, 1, samples 0}`; abandoned-run rows excluded; level 4 → −5d run; `fixtures('a')` level 3 → the completed one.
7. `levelTimeline`: starts `(0,0)`, cumulative x in days, 27 excluded, previous series `endX 7`, `threshold === needed`, pre-unlock points clamp to 0.
8. `stepChart` (`charts.test.js`): one `path.line` per series, one `.hit` per point, `.ref` with threshold, empty series ok. `slimSubject` (`diff.test.js`): `components` kanji-only; `image` when characters null.

**E2E** (`tests/e2e.sh`, scenario a): `#level-select` has 4 options, value `"4"`; 3 `details.heat-grade` in the panel; `svg.chart` count 6; selecting level 3 re-renders; no horizontal scroll; screenshot `tests/screenshot-level.png`. Run `bash tests/e2e.sh`.

**Manual**: `uv run python -m http.server 8000` → `public/index.html?mock=a`; real account via `?mock=real` after `scripts/record-fixtures.sh`: image radicals, ETA vs WaniKani's level page, and the one-time subjects re-download on an existing browser.

## Save

Write the final plan to `docs/plans/level-progress.md` when implementation starts.
