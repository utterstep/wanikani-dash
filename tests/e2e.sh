#!/usr/bin/env bash
# Runs in-browser unit tests and an end-to-end smoke test via agent-browser.
# The app's /api is faked in-page (tests/fake-server.js runs the real account logic over an
# in-memory store), so this needs only a static server — no wrangler. The Worker + Durable
# Object themselves are covered by `vitest run` (tests/worker/).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8765}
uv run python -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; agent-browser close >/dev/null 2>&1 || true' EXIT
sleep 0.7
B="http://127.0.0.1:$PORT"
APP="$B/public/index.html"
fail=0

status() { agent-browser eval 'document.getElementById("status").textContent'; }
reset_all() { agent-browser eval 'indexedDB.deleteDatabase("wkdash"); localStorage.clear(); localStorage.setItem("wk_api_key","test-token"); 1' >/dev/null; }
wait_dash() { agent-browser wait --fn 'document.getElementById("dashboard") && !document.getElementById("dashboard").hidden' >/dev/null; }

echo "== unit tests"
agent-browser open "$B/tests/index.html" >/dev/null
agent-browser wait --fn 'window.__done === true' >/dev/null
title=$(agent-browser eval 'document.title')
echo "$title"
if agent-browser eval 'window.__results.filter(r=>!r.ok).map(r=>r.name+": "+r.error).join("\n")' | grep -v '^""$' | grep -q .; then
  agent-browser eval 'window.__results.filter(r=>!r.ok).map(r=>r.name+": "+r.error).join("\n")'
  fail=1
fi

echo "== e2e: first sync on an empty server account (scenario a)"
agent-browser open "$APP?mock=a" >/dev/null
reset_all
agent-browser eval 'location.reload(); 1' >/dev/null
wait_dash
agent-browser wait --fn '/First sync done/.test(document.getElementById("status").textContent)' >/dev/null
status | grep -q "First sync done" || { echo "FAIL: no first-sync status: $(status)"; fail=1; }
agent-browser eval 'document.querySelectorAll("#cards .card").length' | grep -q 5 || { echo "FAIL: cards"; fail=1; }
agent-browser eval 'document.getElementById("actions").hidden' | grep -q false || { echo "FAIL: actions row"; fail=1; }
agent-browser eval 'document.querySelectorAll("svg.chart").length' | grep -q 6 || { echo "FAIL: charts"; fail=1; }
agent-browser eval 'document.querySelector("#leeches table") !== null' | grep -q true || { echo "FAIL: leeches"; fail=1; }
agent-browser eval 'document.getElementById("history-note").textContent' | grep -q "on the server" || { echo "FAIL: history note"; fail=1; }
agent-browser screenshot tests/screenshot-a.png >/dev/null

echo "== e2e: level progress"
agent-browser eval 'document.getElementById("level").hidden' | grep -q false || { echo "FAIL: level panel hidden"; fail=1; }
agent-browser eval 'document.querySelectorAll("#level-select option").length' | grep -q 4 || { echo "FAIL: level options"; fail=1; }
agent-browser eval 'document.getElementById("level-select").value' | grep -q '"4"' || { echo "FAIL: level defaults to current"; fail=1; }
agent-browser eval 'document.querySelectorAll("#level-summary .mini").length >= 3' | grep -q true || { echo "FAIL: level summary cards"; fail=1; }
agent-browser eval 'document.querySelectorAll("#level-grid details .heat").length' | grep -q 1 || { echo "FAIL: level 4 has one kanji in the fixture"; fail=1; }
agent-browser eval 'document.querySelector("#level-chart svg.chart") !== null' | grep -q true || { echo "FAIL: level timeline"; fail=1; }
agent-browser eval 'document.querySelector("#cards .card:nth-child(3) .card-sub").textContent' | grep -q "earliest" || { echo "FAIL: next-level card lacks the ETA"; fail=1; }
agent-browser eval '(() => { const s = document.getElementById("level-select"); s.value = "3"; s.dispatchEvent(new Event("change")); return document.querySelectorAll("#level-grid details .heat").length; })()' | grep -q 3 || { echo "FAIL: level 3 items"; fail=1; }
agent-browser eval 'document.querySelector("#level-summary").textContent' | grep -q "Level passed" || { echo "FAIL: past level shows pass date"; fail=1; }
agent-browser screenshot tests/screenshot-level.png >/dev/null
agent-browser eval '(() => { const s = document.getElementById("level-select"); s.value = "4"; s.dispatchEvent(new Event("change")); return 1; })()' >/dev/null

echo "== e2e: kanken heat map"
agent-browser eval 'document.querySelectorAll("#kanken-select option").length' | grep -q 11 || { echo "FAIL: kanken levels"; fail=1; }
agent-browser eval 'document.querySelectorAll("#kanken-select option[disabled]").length' | grep -q 3 || { echo "FAIL: 4級/3級/準2級 should be disabled"; fail=1; }
agent-browser eval 'document.getElementById("kanken-select").value' | grep -q '"5"' || { echo "FAIL: kanken default level"; fail=1; }
agent-browser eval 'document.querySelectorAll("#kanken-heat details.heat-grade").length' | grep -q 6 || { echo "FAIL: one section per school grade"; fail=1; }
agent-browser eval 'document.querySelectorAll("#kanken-legend .heat").length' | grep -q 8 || { echo "FAIL: legend sample cells"; fail=1; }
agent-browser eval 'document.documentElement.scrollWidth <= document.documentElement.clientWidth' | grep -q true || { echo "FAIL: page scrolls horizontally"; fail=1; }
agent-browser eval 'document.querySelectorAll("#kanken-heat .heat").length' | grep -q 1026 || { echo "FAIL: 5級 cell count"; fail=1; }
agent-browser eval 'document.querySelectorAll("#kanken-heat .heat:not(.st-absent)").length' | grep -q 4 || { echo "FAIL: the 4 fixture kanji should be coloured"; fail=1; }
agent-browser eval '(() => { const s = document.getElementById("kanken-select"); s.value = "2"; s.dispatchEvent(new Event("change")); return document.querySelectorAll("#kanken-heat .heat").length; })()' | grep -q 2136 || { echo "FAIL: 2級 cell count"; fail=1; }
agent-browser eval 'localStorage.getItem("wk_kanken")' | grep -q '"2"' || { echo "FAIL: kanken choice not persisted"; fail=1; }
agent-browser screenshot tests/screenshot-kanken.png >/dev/null
agent-browser eval 'localStorage.removeItem("wk_kanken"); 1' >/dev/null

echo "== e2e: reopening later pulls what the server collected (scenario b)"
agent-browser open "$APP?mock=b" >/dev/null
agent-browser wait --fn '!document.getElementById("dashboard").hidden && /SRS changes/.test(document.getElementById("status").textContent)' >/dev/null
status | grep -q "+3 reviews, 4 SRS changes" || { echo "FAIL: second sync status: $(status)"; fail=1; }
agent-browser eval 'document.querySelectorAll("#actions a.cta").length' | grep -q 2 || { echo "FAIL: lesson/review buttons"; fail=1; }
agent-browser eval 'Object.values(JSON.parse(localStorage.__mock_server))[0].meta.find(([k]) => k === "version")[1]' | grep -q '^2$' || { echo "FAIL: server state not persisted at version 2"; fail=1; }
agent-browser screenshot tests/screenshot-b.png >/dev/null

echo "== e2e: bad key → settings dialog"
agent-browser eval 'localStorage.setItem("wk_api_key","nope"); location.reload(); 1' >/dev/null
agent-browser wait --fn 'document.getElementById("settings").open' >/dev/null
agent-browser eval 'document.getElementById("settings-msg").textContent' | grep -q "rejected" || { echo "FAIL: auth error"; fail=1; }

echo "== e2e: old-origin page with no history offers copy-token-and-continue"
reset_all
agent-browser open "$B/index.html?mock=a" >/dev/null
agent-browser wait --fn '!document.getElementById("plain").hidden' >/dev/null
agent-browser eval 'document.getElementById("link").href' | grep -q "https://wkdash.utterstep.app/" || { echo "FAIL: redirect target"; fail=1; }
agent-browser eval 'document.getElementById("migrate").hidden' | grep -q true || { echo "FAIL: migrate offered without history"; fail=1; }
agent-browser eval 'navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; 1' >/dev/null
agent-browser click '#go2' >/dev/null
agent-browser wait --fn 'document.getElementById("plain").dataset.done === "1"' >/dev/null
agent-browser eval 'window.__copied' | grep -q '"test-token"' || { echo "FAIL: token not copied: $(agent-browser eval 'window.__copied')"; fail=1; }

echo "== e2e: old-origin page uploads pre-server history, new site continues from it"
reset_all
agent-browser open "$B/index.html?mock=b&legacy=1&foo=1#bar" >/dev/null
agent-browser wait --fn '!document.getElementById("migrate").hidden' >/dev/null
agent-browser eval 'document.getElementById("msg").textContent' | grep -q "history since" || { echo "FAIL: migrate message"; fail=1; }
agent-browser eval 'document.getElementById("link").href' | grep -q "https://wkdash.utterstep.app/?foo=1#bar" || { echo "FAIL: query/hash not carried: $(agent-browser eval 'document.getElementById("link").href')"; fail=1; }
agent-browser eval 'navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; 1' >/dev/null
agent-browser click '#upload' >/dev/null
agent-browser wait --fn 'document.getElementById("plain").dataset.done === "1"' >/dev/null
agent-browser eval 'document.getElementById("err").textContent' | grep -q "Uploaded" || { echo "FAIL: upload status: $(agent-browser eval 'document.getElementById("err").textContent')"; fail=1; }
agent-browser eval 'window.__copied' | grep -q '"test-token"' || { echo "FAIL: token not copied after upload"; fail=1; }
agent-browser eval 'Object.values(JSON.parse(localStorage.__mock_server))[0].meta.find(([k]) => k === "history_since")[1]' | grep -q '2026-08-15' || { echo "FAIL: server did not adopt legacy history"; fail=1; }
agent-browser open "$B/index.html?mock=b&legacy=1" >/dev/null
agent-browser wait --fn '!document.getElementById("plain").hidden' >/dev/null
agent-browser eval 'document.getElementById("migrate").hidden' | grep -q true || { echo "FAIL: migrate offered twice"; fail=1; }
agent-browser open "$APP?mock=b" >/dev/null
agent-browser wait --fn '!document.getElementById("dashboard").hidden && /SRS changes/.test(document.getElementById("status").textContent)' >/dev/null
status | grep -q "+3 reviews, 4 SRS changes" || { echo "FAIL: post-migration sync status: $(status)"; fail=1; }
agent-browser eval 'document.getElementById("history-note").textContent' | grep -q "Aug 15, 2026" || { echo "FAIL: migrated history_since not kept: $(agent-browser eval 'document.getElementById("history-note").textContent')"; fail=1; }

echo "== e2e: old-origin page refuses to upload over an existing server account"
reset_all
agent-browser open "$APP?mock=a" >/dev/null
agent-browser eval 'location.reload(); 1' >/dev/null
wait_dash
agent-browser eval 'indexedDB.deleteDatabase("wkdash"); 1' >/dev/null
agent-browser open "$B/index.html?mock=a&legacy=1" >/dev/null
agent-browser wait --fn '!document.getElementById("migrate").hidden' >/dev/null
agent-browser click '#upload' >/dev/null
agent-browser wait --fn 'document.getElementById("plain").dataset.done === "1"' >/dev/null
agent-browser eval 'document.getElementById("err").textContent' | grep -q "already has history" || { echo "FAIL: expected refusal: $(agent-browser eval 'document.getElementById("err").textContent')"; fail=1; }
agent-browser open "$APP?mock=a" >/dev/null
wait_dash

echo "== e2e: delete account on server"
agent-browser eval 'window.confirm = () => true; 1' >/dev/null
agent-browser click '#open-settings' >/dev/null
agent-browser click '#delete-server' >/dev/null
agent-browser wait --fn '/Deleted on the server/.test(document.getElementById("settings-msg").textContent)' >/dev/null
agent-browser eval 'localStorage.getItem("wk_api_key")' | grep -q null || { echo "FAIL: key not forgotten"; fail=1; }
agent-browser eval 'Object.values(JSON.parse(localStorage.__mock_server))[0].meta.some(([k]) => k === "status")' | grep -q false || { echo "FAIL: server account not emptied"; fail=1; }

[ $fail -eq 0 ] && echo "ALL OK" || { echo "FAILURES"; exit 1; }
