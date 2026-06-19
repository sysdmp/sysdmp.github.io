// SPDX-License-Identifier: MIT
// Characterization study: how do the web and Python BIAS models compare?
//
// The two are different by design:
//   - Python --bias: tiered "equal-share floor then maximize" pre-pass (strong).
//   - Web bias:      a soft per-stat objective weight nudge (±n * 0.25 / MAX_GAIN).
// So this is NOT a pass/fail cross-test — it measures *where and how much* they
// diverge across 100+ builds, with "equivalent intent" inputs (favor the same
// stat[s]). For each case we run Python's --bias and the web bias at several
// strengths, and report agreement on the favored stat's value and the build.
//
// Run: node src/bias-study.mjs   (needs uv + the Python prototype)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATS, BALANCE_WEIGHTS } from './data.js';
import { solveMaxTotal } from './solver.js';

const require = createRequire(import.meta.url);
// src/ sits at the repo root now; the Python prototype lives in pycli/.
const PYDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pycli');
const PY = join(PYDIR, 'ddda-build-solver.py');
const highsLoader = require('highs');
const fs = require('node:fs');
const highs = await highsLoader({ wasmBinary: fs.readFileSync(require.resolve('highs/runtime')) });

const wScore = (s) => STATS.reduce((a, k) => a + BALANCE_WEIGHTS[k] * s[k], 0);

// Python: --bias with the given comma string (e.g. "attack" or "attack=mattack").
function pyBias(biasStr, extra = []) {
  const out = execFileSync('uv', ['run', PY, '--no-default', '--bias', biasStr, ...extra, '--json'],
    { cwd: PYDIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out).builds[0].final_stats;
}
// Web: bias map { stat: n }.
function webBias(biasMap, opts = {}) {
  return solveMaxTotal(highs, { bias: biasMap, ...opts }).stats;
}

const favored = (biasStr) => biasStr.split(/[=,]/).map((s) => s.replace(/^-/, ''));
const sumOf = (s, ks) => ks.reduce((a, k) => a + s[k], 0);

// Build the case list: every single stat, several pairs, a few with a weight
// class, and a couple of negative-bias cases — each compared at web strengths
// 1..5. That yields well over 100 builds.
const SINGLE = STATS;
const PAIRS = [['attack', 'mattack'], ['defense', 'mdefense'], ['attack', 'defense'],
               ['mattack', 'mdefense'], ['hp', 'st'], ['attack', 'mdefense'],
               ['defense', 'mattack'], ['hp', 'attack'], ['st', 'mattack'],
               ['defense', 'attack'], ['mdefense', 'mattack']];
// every stat under each weight class (light vs heavy shifts the st baseline)
const WEIGHTED = STATS.flatMap((s) => [['SS'], ['LL']].map(([w]) => [s, w]));

let builds = 0;
let matchAt5 = 0, dirAgree = 0, total = 0;
const rows = [];

function study(label, biasStr, opts = {}) {
  const fk = favored(biasStr);
  const py = pyBias(biasStr, opts.weight ? ['--weight', opts.weight] : []);
  builds++;
  const baseFav = sumOf(opts.weight ? unbiasedFor(opts.weight) : UNBIASED, fk);
  // sweep web strength 1..5; remember the closest to Python and the n=5 result
  let best = null, web5 = null;
  for (let n = 1; n <= 5; n++) {
    const w = webBias(Object.fromEntries(fk.map((k) => [k, n])), opts);
    builds++;
    const diff = Math.abs(sumOf(w, fk) - sumOf(py, fk));
    if (!best || diff < best.diff) best = { n, w, diff };
    if (n === 5) web5 = w;
  }
  total++;
  // direction agreement: both raise the favored sum above the unbiased baseline?
  const pyUp = sumOf(py, fk) >= baseFav, webUp = sumOf(web5, fk) >= baseFav;
  if (pyUp && webUp) dirAgree++;
  if (sumOf(web5, fk) === sumOf(py, fk)) matchAt5++;
  rows.push({
    label,
    pyFav: sumOf(py, fk),
    web5Fav: sumOf(web5, fk),
    bestN: best.n,
    webFavAtBest: sumOf(best.w, fk),
  });
}

// Unbiased baseline per weight class (st shifts with weight).
const ubCache = {};
const unbiasedFor = (w) => (ubCache[w] ??= solveMaxTotal(highs, { weight: w }).stats);

const UNBIASED = solveMaxTotal(highs, {}).stats;

console.log('Comparing Python --bias vs web bias (favored-stat sum), web swept 1..5:\n');
console.log('case'.padEnd(34), 'py'.padStart(6), 'web@5'.padStart(7), 'bestN'.padStart(6), 'web@bestN'.padStart(10));
console.log('-'.repeat(70));

for (const s of SINGLE) study(`bias ${s}`, s);
for (const [a, b] of PAIRS) study(`bias ${a}=${b}`, `${a}=${b}`);
for (const [s, w] of WEIGHTED) study(`bias ${s} +wt ${w}`, s, { weight: w });

for (const r of rows) {
  console.log(r.label.padEnd(34), String(r.pyFav).padStart(6), String(r.web5Fav).padStart(7),
    String(r.bestN).padStart(6), String(r.webFavAtBest).padStart(10));
}

console.log('-'.repeat(70));
console.log(`builds solved: ${builds}`);
console.log(`cases: ${total}`);
console.log(`direction agreement (both favor the stat vs unbiased): ${dirAgree}/${total}`);
console.log(`web@5 exactly equals Python on the favored sum: ${matchAt5}/${total}`);
const bestNs = rows.map((r) => r.bestN);
const hist = {}; for (const n of bestNs) hist[n] = (hist[n] || 0) + 1;
console.log(`web strength that best matches Python (histogram of bestN): ${JSON.stringify(hist)}`);
