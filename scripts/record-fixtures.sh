#!/usr/bin/env bash
# Records real WaniKani API responses into tests/fixtures/real-*.json (gitignored).
# Reads API_KEY from .env; never prints it.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${API_KEY:=${API_TOKEN:-}}"
: "${API_KEY:?API_KEY or API_TOKEN missing in .env}"
OUT=tests/fixtures
mkdir -p "$OUT"

get() { curl -fsS -H "Authorization: Bearer $API_KEY" -H "Wanikani-Revision: 20170710" "$1"; }

get https://api.wanikani.com/v2/user > "$OUT/real-user.json"
echo "user ok"
get https://api.wanikani.com/v2/summary > "$OUT/real-summary.json" || echo "summary: token lacks permission (skipped)"

# Collections: follow next_url, concatenate .data arrays.
collect() {
  local name=$1 url="https://api.wanikani.com/v2/$1" tmp
  tmp=$(mktemp)
  echo "[]" > "$tmp"
  while [ "$url" != "null" ] && [ -n "$url" ]; do
    local page; page=$(get "$url")
    jq -s '.[0] + .[1].data' "$tmp" <(echo "$page") > "$tmp.next" && mv "$tmp.next" "$tmp"
    url=$(echo "$page" | jq -r '.pages.next_url')
    echo "$name: $(jq length "$tmp")"
  done
  mv "$tmp" "$OUT/real-$name.json"
}
for c in level_progressions assignments review_statistics subjects; do collect "$c"; done
echo "done → $OUT/real-*.json"
