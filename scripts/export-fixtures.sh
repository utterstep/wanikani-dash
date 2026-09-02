#!/usr/bin/env bash
# Exports tests/fixtures/synthetic.js scenarios to JSON for the Rust tests (crates/wkdash-core/tests).
set -euo pipefail
cd "$(dirname "$0")/.."
pkgx node --input-type=module -e "
import { fixtures } from './tests/fixtures/synthetic.js';
import { writeFileSync } from 'node:fs';
for (const s of ['a', 'b']) writeFileSync('tests/fixtures/synthetic-' + s + '.json', JSON.stringify(fixtures(s), null, 1) + '\n');
"
echo "wrote tests/fixtures/synthetic-{a,b}.json"
