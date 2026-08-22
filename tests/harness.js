// Tiny in-browser test harness. Results go to the DOM + window.__results.

const results = [];
const suites = [];
let current = null;

export function describe(name, fn) { suites.push({ name, fn }); }
export function it(name, fn) { current.tests.push({ name, fn }); }

export function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function assertEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
export function assertClose(actual, expected, eps = 1e-6, msg = '') {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg} expected ≈${expected}, got ${actual}`);
}

export async function run() {
  const ul = document.getElementById('results');
  for (const s of suites) {
    current = { name: s.name, tests: [] };
    s.fn();
    for (const t of current.tests) {
      const li = document.createElement('li');
      const full = `${s.name} › ${t.name}`;
      try {
        await t.fn();
        li.dataset.status = 'pass';
        li.textContent = `✓ ${full}`;
        results.push({ name: full, ok: true });
      } catch (e) {
        li.dataset.status = 'fail';
        li.textContent = `✗ ${full}\n${e.stack || e.message}`;
        results.push({ name: full, ok: false, error: String(e.message) });
      }
      ul.appendChild(li);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  document.title = `${results.length - failed} passed / ${failed} failed`;
  document.getElementById('summary').textContent = document.title;
  window.__results = results;
  window.__done = true;
}
