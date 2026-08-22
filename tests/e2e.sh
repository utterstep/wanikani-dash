#!/usr/bin/env bash
# Runs in-browser unit tests and an end-to-end smoke test via agent-browser.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8765}
uv run python -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; agent-browser close >/dev/null 2>&1 || true' EXIT
sleep 0.7
B="http://127.0.0.1:$PORT"
fail=0

echo "== unit tests"
agent-browser open "$B/tests/index.html" >/dev/null
agent-browser wait --fn 'window.__done === true' >/dev/null
title=$(agent-browser eval 'document.title')
echo "$title"
if agent-browser eval 'window.__results.filter(r=>!r.ok).map(r=>r.name+": "+r.error).join("\n")' | grep -v '^""$' | grep -q .; then
  agent-browser eval 'window.__results.filter(r=>!r.ok).map(r=>r.name+": "+r.error).join("\n")'
  fail=1
fi

echo "== e2e: first sync (scenario a)"
agent-browser open "$B/index.html?mock=a" >/dev/null
agent-browser eval 'indexedDB.deleteDatabase("wkdash"); localStorage.clear(); localStorage.setItem("wk_api_key","test-token"); location.reload(); 1' >/dev/null
agent-browser wait --fn 'document.getElementById("dashboard") && !document.getElementById("dashboard").hidden' >/dev/null
agent-browser eval 'document.getElementById("status").textContent' | grep -q "First sync" || { echo "FAIL: no first-sync status"; fail=1; }
agent-browser eval 'document.querySelectorAll("#cards .card").length' | grep -q 5 || { echo "FAIL: cards"; fail=1; }
agent-browser eval 'document.getElementById("actions").hidden' | grep -q false || { echo "FAIL: actions row"; fail=1; }
agent-browser eval 'document.querySelectorAll("svg.chart").length' | grep -q 5 || { echo "FAIL: charts"; fail=1; }
agent-browser eval 'document.querySelector("#leeches table") !== null' | grep -q true || { echo "FAIL: leeches"; fail=1; }
agent-browser screenshot tests/screenshot-a.png >/dev/null

echo "== e2e: second sync (scenario b) produces events"
agent-browser open "$B/index.html?mock=b" >/dev/null
agent-browser wait --fn '!document.getElementById("dashboard").hidden && /SRS changes/.test(document.getElementById("status").textContent)' >/dev/null
agent-browser eval 'document.getElementById("status").textContent' | grep -q "+3 reviews, 4 SRS changes" || { echo "FAIL: second sync status: $(agent-browser eval 'document.getElementById("status").textContent')"; fail=1; }
agent-browser eval 'document.querySelectorAll("#actions a.cta").length' | grep -q 2 || { echo "FAIL: lesson/review buttons"; fail=1; }
agent-browser screenshot tests/screenshot-b.png >/dev/null

echo "== e2e: bad key → settings dialog"
agent-browser eval 'localStorage.setItem("wk_api_key","nope"); location.reload(); 1' >/dev/null
agent-browser wait --fn 'document.getElementById("settings").open' >/dev/null
agent-browser eval 'document.getElementById("settings-msg").textContent' | grep -q "rejected" || { echo "FAIL: auth error"; fail=1; }

[ $fail -eq 0 ] && echo "ALL OK" || { echo "FAILURES"; exit 1; }
