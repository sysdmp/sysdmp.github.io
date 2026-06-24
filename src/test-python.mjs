// SPDX-License-Identifier: MIT
// Cross-validation: compare the web (HiGHS) solver against the Python prototype,
// treating Python as the source of truth. Two suites:
//   - STATIC:  a fixed list of representative cases (deterministic).
//   - DYNAMIC: randomly generated cases each run (fuzz; seed via DDDA_SEED).
//
// What we compare: the optimal value of the objective, NOT the raw allocation —
// many builds tie at the optimum, so allocations legitimately differ between
// solvers. The comparable invariant is:
//   * default / bounds / divisor / match(=) / weight / pawn / require / start  ->
//     the BALANCED weighted stat score (hp,st weight 0.1; combat 1.0), which is unique.
//   * --bias  -> the BIAS-weighted (eff_weights) stat score, which both solvers now
//     optimize identically after the same equal-share floor pre-pass.
//   * --maximize STAT  -> the exact maximized stat value (its lexicographic top
//     priority), which is also unique.
//
// Everything the web solver supports is cross-tested. Combat-stat ~ matches use
// tolerance 10, the hp~st pair 100 — both match the prototype; bias uses the same
// model on both sides. (Python's --nice was removed; the web never had it.)
//
// Run: npm run test:py   (needs `uv` + the Python prototype in the repo root)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATS, BALANCE_WEIGHTS } from './data.js';
import { solveMaxTotal, enumerateSameStats, biasTiersFromMap, biasRanks, effWeights } from './solver.js';

// Bias-weighted score using the same eff_weights both solvers optimize.
const effScore = (stats, bias) => {
  const w = effWeights(biasRanks(biasTiersFromMap(bias ?? {})));
  return STATS.reduce((a, k) => a + w[k] * stats[k], 0);
};

const require = createRequire(import.meta.url);
// src/ sits at the repo root now; the Python prototype lives in pycli/.
const PYDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pycli');
const PY = join(PYDIR, 'ddda-build-solver.py');

const highsLoader = require('highs');
const fs = require('node:fs');
const highs = await highsLoader({ wasmBinary: fs.readFileSync(require.resolve('highs/runtime')) });

const wScore = (stats) => STATS.reduce((a, k) => a + BALANCE_WEIGHTS[k] * stats[k], 0);

// --- translate a web-style opts object into Python CLI flags ---------------
function pyArgs(opts) {
  // Neither side applies default stat floors anymore, so no --no-default needed:
  // both solve fully unconstrained unless the opts say otherwise.
  const args = [];
  for (const k of STATS) {
    const b = opts.bounds?.[k];
    if (!b) continue;
    if (b.divisor != null) args.push('--divisor', `${k}=${b.divisor}`);
    if (b.min != null && b.max != null && b.min === b.max) args.push(`--${k}`, String(b.min));
    else {
      if (b.min != null) args.push(`--${k}-min`, String(b.min));
      if (b.max != null) args.push(`--${k}-max`, String(b.max));
    }
  }
  if (opts.match?.length) {
    args.push('--match', opts.match.map(({ a, b, tol }) => `${a}${tol === 0 ? '=' : '~'}${b}`).join(','));
  }
  if (opts.maximize) args.push('--maximize', opts.maximize);
  if (opts.minimizeVocations) args.push('--minimize-vocations');
  if (opts.noPre10Switch) args.push('--no-early-switcheroo');
  if (opts.pawn) args.push('--pawn');
  if (opts.weight) args.push('--weight', opts.weight);
  if (opts.require && Object.keys(opts.require).length) {
    args.push('--require', Object.entries(opts.require).map(([v, n]) => `${v}=${n}`).join(','));
  }
  if (opts.startPool?.length === 1) args.push('--start-as', opts.startPool[0]);
  // Bias: render the web {stat:int} map as Python's --bias tier string via the shared
  // tier mapping — positive tiers (high→low) as `=`-joined groups, then negative tiers
  // prefixed with `-`. Use the --bias=... form so a leading `-` survives argparse.
  if (opts.bias && Object.keys(opts.bias).length) {
    const segs = biasTiersFromMap(opts.bias).map(({ sign, stats }) =>
      (sign < 0 ? '-' : '') + stats.join('='));
    args.push(`--bias=${segs.join(',')}`);
  }
  // hp/st are NOT discounted in the web "balanced" objective unless we ask Python
  // to match; the web default discounts them, so DON'T pass --equal-weights.
  return args;
}

// Run Python; returns { feasible, stats, vocs } (null/0 when infeasible).
function runPython(opts) {
  let out;
  try {
    out = execFileSync('uv', ['run', PY, ...pyArgs(opts), '--json'],
      { cwd: PYDIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return { feasible: false, stats: null, error: e.message };
  }
  const doc = JSON.parse(out);
  if (doc.infeasible || !doc.builds?.length) return { feasible: false, stats: null, vocs: 0 };
  const b = doc.builds[0];
  const vocs = new Set(['to10', 'to100', 'to200']
    .flatMap((t) => Object.keys(b.levels[t] || {}))).size;
  return { feasible: true, stats: b.final_stats, vocs };
}

function runWeb(opts) {
  try {
    const b = solveMaxTotal(highs, opts);
    const vocs = new Set(['to10', 'to100', 'to200']
      .flatMap((t) => Object.keys(b.counts[t] || {}))).size;
    return { feasible: true, stats: b.stats, vocs };
  } catch {
    return { feasible: false, stats: null, vocs: 0 };
  }
}

let failures = 0, count = 0;
function compare(label, opts) {
  count++;
  const py = runPython(opts);
  const web = runWeb(opts);

  // 1. Feasibility must agree.
  if (py.feasible !== web.feasible) {
    console.log(`FAIL - ${label}: feasibility mismatch (py=${py.feasible}, web=${web.feasible})`);
    failures++;
    return;
  }
  if (!py.feasible) { console.log(`ok   - ${label}: both infeasible`); return; }

  // 2. The objective optimum must match. The comparable invariant depends on the
  //    dominant objective term:
  //      --maximize STAT          -> the exact maximized stat value
  //      --minimize-vocations     -> the distinct-vocation count (its dominant term)
  //      otherwise                -> the balanced weighted score
  //    Both solvers prove exact optima (web runs HiGHS at zero MIP gap), so the
  //    dominant objective value matches. Allocations may still differ on ties.
  const SCORE_TOL = 1e-6;
  let ok, detail;
  if (opts.maximize) {
    const k = opts.maximize;
    ok = py.stats[k] === web.stats[k];
    detail = `max ${k}: py ${py.stats[k]} vs web ${web.stats[k]}`;
  } else if (opts.minimizeVocations) {
    const pv = py.vocs, wv = web.vocs;
    ok = pv === wv;
    detail = `distinct vocations: py ${pv} vs web ${wv}`;
  } else if (opts.bias && Object.keys(opts.bias).length) {
    // Bias: compare the eff_weights-weighted optimum (both sides optimize it after
    // the same equal-share floor pre-pass). Allocations/favored values may tie.
    const ps = effScore(py.stats, opts.bias), ws = effScore(web.stats, opts.bias);
    ok = Math.abs(ps - ws) <= SCORE_TOL;
    detail = `bias score py ${ps.toFixed(3)} vs web ${ws.toFixed(3)}`;
  } else {
    const ps = wScore(py.stats), ws = wScore(web.stats);
    ok = Math.abs(ps - ws) <= SCORE_TOL;
    detail = `score py ${ps.toFixed(1)} vs web ${ws.toFixed(1)}`;
  }
  // 3. Every honored bound the web build reports must also hold (sanity on web).
  for (const k of STATS) {
    const b = opts.bounds?.[k];
    if (b?.min != null && web.stats[k] < b.min) { ok = false; detail += ` [web ${k}<min]`; }
    if (b?.max != null && b.divisor == null && web.stats[k] > b.max) { ok = false; detail += ` [web ${k}>max]`; }
    if (b?.divisor != null && web.stats[k] % b.divisor !== 0) { ok = false; detail += ` [web ${k}∤${b.divisor}]`; }
  }
  // 3b. require / start are structural: both solvers must honor them. Re-solve the
  //     web side for its counts (runWeb returns only stats) to assert the to100
  //     minimums and the forced start.
  if ((opts.require && Object.keys(opts.require).length) || opts.startPool?.length === 1) {
    try {
      const wb = solveMaxTotal(highs, opts);
      for (const [v, n] of Object.entries(opts.require ?? {})) {
        if ((wb.counts.to100[v] ?? 0) < n) { ok = false; detail += ` [web ${v} to100<${n}]`; }
      }
      if (opts.startPool?.length === 1 && wb.start !== opts.startPool[0]) {
        ok = false; detail += ` [web start ${wb.start}≠${opts.startPool[0]}]`;
      }
    } catch { /* infeasible already handled above */ }
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label}: ${detail}`);
  if (!ok) failures++;
}

// Canonical key for an allocation, so the web and Python build sets can be compared
// as sets regardless of enumeration order.
function allocKey(start, counts) {
  const tier = (m) => Object.entries(m || {}).filter(([, n]) => n > 0)
    .sort().map(([v, n]) => `${v}:${n}`).join(',');
  return `${start}|${tier(counts.to10)}|${tier(counts.to100)}|${tier(counts.to200)}`;
}

// Cross-check the SAME-STATS enumeration: the web's enumerateSameStats and Python's
// `--count` with all six stats pinned exactly should find the identical SET of
// allocations. Only meaningful for a target with a small, fully-enumerable count
// (so both finish under `cap` without truncating). `opts` should pin enough that the
// build is interesting; we read the solved stats and pin all six for both sides.
function compareEnumerate(label, opts, cap = 30) {
  count++;
  let seed;
  try { seed = solveMaxTotal(highs, opts); }
  catch { console.log(`FAIL - ${label}: web seed infeasible`); failures++; return; }

  // Web: full same-stats enumeration.
  const { builds: webBuilds, capped: webCapped } = enumerateSameStats(highs, opts, seed.stats, cap);
  const webSet = new Set(webBuilds.map((b) => allocKey(b.start, b.counts)));

  // Python: pin all six stats exactly + --count cap. Carry through the structural opts
  // (weight/pawn/no-switcheroo/start/avoid) via pyArgs, then override with exact stats.
  const pinnedOpts = { ...opts, bounds: {} };
  for (const k of STATS) pinnedOpts.bounds[k] = { min: seed.stats[k], max: seed.stats[k] };
  let doc;
  try {
    const out = execFileSync('uv', ['run', PY, ...pyArgs(pinnedOpts), '--count', String(cap), '--json'],
      { cwd: PYDIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    doc = JSON.parse(out);
  } catch (e) { console.log(`FAIL - ${label}: python errored (${e.message})`); failures++; return; }
  const pyBuilds = doc.builds || [];
  const pySet = new Set(pyBuilds.map((b) => allocKey(b.start, b.levels)));

  // If either side hit the cap the sets may be truncated differently — require the
  // case to be small enough that neither is capped (test author picks such targets).
  const capHit = webCapped || webBuilds.length >= cap || pyBuilds.length >= cap;
  const same = webSet.size === pySet.size && [...webSet].every((k) => pySet.has(k));
  const ok = !capHit && same;
  let detail = `web ${webSet.size} vs py ${pySet.size} allocations`;
  if (capHit) detail += ' [CAP HIT — pick a smaller target]';
  else if (!same) {
    const onlyWeb = [...webSet].filter((k) => !pySet.has(k));
    const onlyPy = [...pySet].filter((k) => !webSet.has(k));
    detail += ` [web-only ${onlyWeb.length}, py-only ${onlyPy.length}]`;
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label}: ${detail}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// STATIC suite — fixed, representative cases.
// ---------------------------------------------------------------------------
console.log('# static');
compare('default balanced', {});
compare('hp>=3600', { bounds: { hp: { min: 3600 } } });
compare('attack>=600, mattack>=400', { bounds: { attack: { min: 600 }, mattack: { min: 400 } } });
compare('defense 400..450', { bounds: { defense: { min: 400, max: 450 } } });
compare('attack exact 700', { bounds: { attack: { min: 700, max: 700 } } });
compare('hp<=4000 ceiling', { bounds: { hp: { max: 4000 } } });
compare('attack divisor 100', { bounds: { attack: { divisor: 100 } } });
compare('mattack divisor 50, >=300', { bounds: { mattack: { divisor: 50, min: 300 } } });
compare('match attack=mattack', { match: [{ a: 'attack', b: 'mattack', tol: 0 }] });
compare('match defense~mdefense (combat ~, tol 10)', { match: [{ a: 'defense', b: 'mdefense', tol: 10 }] });
compare('match hp~st (vitals ~, tol 100)', { match: [{ a: 'hp', b: 'st', tol: 100 }] });
compare('maximize attack', { maximize: 'attack' });
compare('maximize mattack with defense>=300', { maximize: 'mattack', bounds: { defense: { min: 300 } } });
compare('maximize attack capped 500', { maximize: 'attack', bounds: { attack: { max: 500 } } });
compare('weight LL', { weight: 'LL' });
compare('weight LL, st>=4800', { weight: 'LL', bounds: { st: { min: 4800 } } });
compare('pawn', { pawn: true });
compare('pawn, attack>=500', { pawn: true, bounds: { attack: { min: 500 } } });
compare('infeasible attack>=99999', { bounds: { attack: { min: 99999 } } });
compare('combo: hp>=3500, def>=300, attack divisor 50', {
  bounds: { hp: { min: 3500 }, defense: { min: 300 }, attack: { divisor: 50 } },
});
compare('minimize-vocations', { minimizeVocations: true });
compare('minimize-vocations + attack>=500', { minimizeVocations: true, bounds: { attack: { min: 500 } } });
compare('minimize-vocations + pawn', { minimizeVocations: true, pawn: true });
compare('no-early-switcheroo', { noPre10Switch: true });
compare('no-early-switcheroo + mattack>=400', { noPre10Switch: true, bounds: { mattack: { min: 400 } } });
compare('no-early-switcheroo + maximize mattack', { noPre10Switch: true, maximize: 'mattack' });
compare('no-early-switcheroo + weight LL', { noPre10Switch: true, weight: 'LL' });
compare('require warrior=40', { require: { warrior: 40 } });
compare('require warrior=40,sorcerer=10', { require: { warrior: 40, sorcerer: 10 } });
compare('require infeasible (sum>90)', { require: { warrior: 60, sorcerer: 50 } });
compare('require + maximize mattack', { maximize: 'mattack', require: { warrior: 30 } });
compare('start-as mage', { startPool: ['mage'] });
compare('start-as strider + attack>=500', { startPool: ['strider'], bounds: { attack: { min: 500 } } });
compare('start-as fighter + pawn', { startPool: ['fighter'], pawn: true });
compare('start-as mage + require warrior=40', { startPool: ['mage'], require: { warrior: 40 } });
compare('bias attack +3', { bias: { attack: 3 } });
compare('bias attack=mattack tied +4', { bias: { attack: 4, mattack: 4 } });
compare('bias tiered attack>mattack', { bias: { attack: 5, mattack: 2 } });
compare('bias negative defense -3', { bias: { defense: -3 } });
compare('bias mixed +attack -hp', { bias: { attack: 4, hp: -3 } });
compare('bias + weight LL', { bias: { mattack: 5 }, weight: 'LL' });
compare('bias + maximize attack (bias mattack)', { maximize: 'attack', bias: { mattack: 3 } });

// Same-stats ENUMERATION parity: the web's enumerateSameStats and Python's --count
// (all six stats pinned) must find the identical set of allocations. Targets chosen
// to have a small, fully-enumerable count so neither side hits the cap.
compareEnumerate('enumerate: defense=700 (3 allocations)', { bounds: { defense: { min: 700, max: 700 } } });
compareEnumerate('enumerate: defense=750 (2 allocations)', { bounds: { defense: { min: 750, max: 750 } } });

// ---------------------------------------------------------------------------
// DYNAMIC suite — random cases each run (fuzz). Seeded for reproducibility:
// set DDDA_SEED to replay a failing run.
// ---------------------------------------------------------------------------
console.log('# dynamic (random)');
const SEED = Number(process.env.DDDA_SEED ?? (Date.now() % 1e9));
console.log(`(seed ${SEED} — set DDDA_SEED=${SEED} to replay)`);
let s = SEED >>> 0;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const COMBAT = ['attack', 'defense', 'mattack', 'mdefense'];
// conservative ceilings well under each stat's true max, so random mins stay feasible
const SAFE_MIN = { hp: 4500, st: 3800, attack: 700, defense: 550, mattack: 600, mdefense: 550 };

const N = Number(process.env.DDDA_FUZZ ?? 12);
for (let i = 0; i < N; i++) {
  const opts = {};
  const roll = rnd();
  if (roll < 0.3) {
    // maximize a random stat, plus maybe a compatible floor on another
    opts.maximize = pick(STATS);
    if (rnd() < 0.5) {
      const other = pick(STATS.filter((k) => k !== opts.maximize));
      opts.bounds = { [other]: { min: Math.floor(rnd() * SAFE_MIN[other] * 0.6) } };
    }
  } else if (roll < 0.55) {
    // a match: usually a combat pair (= or ~ tol 10), sometimes hp~st (tol 100)
    if (rnd() < 0.25) {
      opts.match = [{ a: 'hp', b: 'st', tol: 100 }];
    } else {
      const a = pick(COMBAT), b = pick(COMBAT.filter((x) => x !== a));
      opts.match = [{ a, b, tol: rnd() < 0.5 ? 0 : 10 }];
    }
  } else if (roll < 0.75) {
    // a divisor on a random stat, maybe with a floor
    const k = pick(STATS);
    opts.bounds = { [k]: { divisor: pick([10, 25, 50, 100]) } };
    if (rnd() < 0.4) opts.bounds[k].min = Math.floor(rnd() * SAFE_MIN[k] * 0.5);
  } else {
    // 1–2 random min bounds
    opts.bounds = {};
    const n = 1 + Math.floor(rnd() * 2);
    for (let j = 0; j < n; j++) {
      const k = pick(STATS);
      opts.bounds[k] = { min: Math.floor(rnd() * SAFE_MIN[k] * 0.7) };
    }
  }
  if (rnd() < 0.3) opts.weight = pick(['SS', 'S', 'M', 'L', 'LL']);
  if (rnd() < 0.25) opts.pawn = true;
  // minimize-vocations is its own dominant objective; only mix it in when not
  // maximizing (the two would compete) and compare on vocation count.
  if (!opts.maximize && rnd() < 0.25) opts.minimizeVocations = true;
  // no-early-switcheroo composes with everything (it just pins the 1->10 range).
  if (rnd() < 0.25) opts.noPre10Switch = true;
  // Occasionally attach a random bias map — only when neither maximize nor minVoc is
  // set, so the bias-weighted score is the comparison invariant (those take priority).
  if (!opts.maximize && !opts.minimizeVocations && rnd() < 0.3) {
    opts.bias = {};
    const n = 1 + Math.floor(rnd() * 2);
    for (let j = 0; j < n; j++) {
      const k = pick(STATS);
      const v = (1 + Math.floor(rnd() * 5)) * (rnd() < 0.7 ? 1 : -1); // ±1..5, mostly +
      opts.bias[k] = v;
    }
  }
  compare(`fuzz#${i + 1} ${JSON.stringify(opts)}`, opts);
}

console.log(`\n${failures ? failures + ` failure(s) of ${count}` : `all ${count} cross-checks passed`}`);
process.exit(failures ? 1 : 0);
