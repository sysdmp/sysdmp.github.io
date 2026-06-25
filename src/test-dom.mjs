// SPDX-License-Identifier: MIT
// Smoke test for the BUILT app's browser-init path. `npm test` (src/test.mjs) only
// exercises the solver (solver.js); it never runs app.js, so a synchronous error in
// app.js's top-level init — e.g. a const used before its declaration (the TIER_SIZE
// temporal-dead-zone bug that once left the weight selector empty) — slips through.
//
// This loads the built index.html into jsdom, runs its inline script, and asserts
// init finished without a script error and actually populated the UI. Any throw
// during synchronous init aborts the script and leaves these elements empty.
//
// Run: npm run test:dom   (needs `make` to have produced index.html, and jsdom)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

// Capture any error the inline script throws (jsdom reports these as "jsdomError"
// on the virtual console) plus runtime window errors.
const scriptErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => scriptErrors.push(e.detail || e));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  pretendToBeVisual: true, // provides requestAnimationFrame (the solve path yields on it)
  url: 'http://localhost/',
  beforeParse(win) {
    // jsdom lacks matchMedia; the app reads it at top-level init for the theme.
    // A real browser always has it, so stub it (this is an environment gap, not an
    // app bug — and we still want the rest of init to run).
    if (!win.matchMedia) {
      win.matchMedia = () => ({
        matches: false, media: '', onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; },
      });
    }
  },
});
const { window } = dom;
window.addEventListener('error', (e) => scriptErrors.push(e.error || e.message));

// The synchronous part of app.js init (building the vocation rows, populating the
// selectors) runs to completion before the first `await` in the load IIFE, so a
// microtask turn is enough for it to have run (and to surface any sync throw).
await new Promise((r) => setTimeout(r, 50));

const doc = window.document;
const $ = (id) => doc.getElementById(id);

check('no error thrown during app init',
      scriptErrors.length === 0,
      scriptErrors.map((e) => (e && e.message) || String(e)).join(' | '));

// These are all populated by app.js's synchronous top-level init. If init aborted
// (the symptom of the TDZ bug), they'd be empty.
check('weight selector populated', ($('weight')?.options.length ?? 0) > 0,
      `${$('weight')?.options.length ?? 0} options`);
check('starting-class selector populated', ($('start-class')?.options.length ?? 0) > 0,
      `${$('start-class')?.options.length ?? 0} options`);
check('maximize selector populated', ($('maximize')?.options.length ?? 0) > 0,
      `${$('maximize')?.options.length ?? 0} options`);
check('vocation rows built', doc.querySelectorAll('#vocs .voc').length > 0,
      `${doc.querySelectorAll('#vocs .voc').length} rows`);
check('per-tier require fields built', doc.querySelectorAll('#vocs input.require').length > 0,
      `${doc.querySelectorAll('#vocs input.require').length} fields`);
check('stat-range rows built', doc.querySelectorAll('#ranges input[data-kind="min"]').length > 0,
      `${doc.querySelectorAll('#ranges input[data-kind="min"]').length} stats`);

dom.window.close();
console.log(`\n${failures ? failures + ' failure(s)' : 'all DOM smoke tests passed'}`);
process.exit(failures ? 1 : 0);
