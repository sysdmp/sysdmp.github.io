// SPDX-License-Identifier: MIT
// Test harness for the solver (src/solver.js, HiGHS backend). Checks against the
// closed-form balanced optimum and every specifier behavior, including the
// coarse-divisor case (st÷3333). Runs under Node (not the bundler), so it loads
// HiGHS via the package's own factory rather than the inlined-wasm build loader.
//
// Run: npm test  (from the repo root)

import { createRequire } from 'node:module';
import {
  STATS, BASIC, ALL, growth, statsOf, TIER_SIZE, WEIGHT_BASE_ST, BALANCE_WEIGHTS,
} from './data.js';
import { solveMaxTotal } from './solver.js';

const require = createRequire(import.meta.url);
const highsLoader = require('highs');
const wasmPath = require.resolve('highs/runtime');

const wGain = (voc, tier) =>
  STATS.reduce((a, k) => a + BALANCE_WEIGHTS[k] * growth(voc, tier, k), 0);
const wScore = (stats) => STATS.reduce((a, k) => a + BALANCE_WEIGHTS[k] * stats[k], 0);

function bruteForceOptimum() {
  let best = null;
  for (const start of BASIC) {
    const counts = { to10: {}, to100: {}, to200: {} };
    for (const tier of ['to10', 'to100', 'to200']) {
      const pool = tier === 'to10' ? BASIC : ALL;
      let bv = pool[0], bg = -Infinity;
      for (const v of pool) { const g = wGain(v, tier); if (g > bg) { bg = g; bv = v; } }
      counts[tier][bv] = TIER_SIZE[tier];
    }
    const stats = statsOf(start, counts);
    const score = wScore(stats);
    if (!best || score > best.score) best = { start, counts, stats, score };
  }
  return best;
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

const fs = require('node:fs');
const highs = await highsLoader({ wasmBinary: fs.readFileSync(wasmPath) });

// 1. Balanced objective matches the closed-form optimum.
const oracle = bruteForceOptimum();
const got = solveMaxTotal(highs);
check('balanced objective equals closed-form optimum',
      Math.abs(wScore(got.stats) - oracle.score) < 1e-6,
      `solver ${wScore(got.stats).toFixed(1)} vs oracle ${oracle.score.toFixed(1)}`);

// 2. Self-consistency + tier sizes + basics-only 1->10.
check('reported stats match statsOf(counts)',
      STATS.every((k) => statsOf(got.start, got.counts)[k] === got.stats[k]));
const tierSum = (t) => Object.values(got.counts[t]).reduce((a, n) => a + n, 0);
check('tier sizes are 9 / 90 / 100',
      tierSum('to10') === 9 && tierSum('to100') === 90 && tierSum('to200') === 100);
check('1->10 uses only basic vocations',
      Object.keys(got.counts.to10).every((v) => BASIC.includes(v)));

// 3. Pool restriction.
const restricted = solveMaxTotal(highs, { allowed: ALL.filter((v) => v !== 'fighter') });
const used = new Set(['to10', 'to100', 'to200'].flatMap((t) => Object.keys(restricted.counts[t])));
check('allowed-pool restriction excludes fighter', !used.has('fighter'));

// 4. Bounds: min / max / range / exact.
check('min bound honored', solveMaxTotal(highs, { bounds: { mattack: { min: 400 } } }).stats.mattack >= 400);
check('max bound honored', solveMaxTotal(highs, { bounds: { hp: { max: 4000 } } }).stats.hp <= 4000);
const rng = solveMaxTotal(highs, { bounds: { defense: { min: 400, max: 450 } } }).stats.defense;
check('range bound honored', rng >= 400 && rng <= 450, `defense ${rng}`);
check('exact bound honored', solveMaxTotal(highs, { bounds: { mattack: { min: 420, max: 420 } } }).stats.mattack === 420);

// 5. Infeasible.
let threw = false;
try { solveMaxTotal(highs, { bounds: { attack: { min: 99999 } } }); } catch { threw = true; }
check('impossible bound is infeasible', threw);

// 6. Divisor — including the coarse st÷3333 case (only one reachable multiple).
check('divisor: attack multiple of 100',
      solveMaxTotal(highs, { bounds: { attack: { divisor: 100 } } }).stats.attack % 100 === 0);
const t0 = Date.now();
const div3333 = solveMaxTotal(highs, {
  bounds: { hp: { min: 3500 }, defense: { min: 300 }, mdefense: { min: 300 }, st: { divisor: 3333 } },
});
const dt = Date.now() - t0;
check('coarse divisor st÷3333 solves (and is fast)',
      div3333.stats.st % 3333 === 0 && dt < 5000, `st ${div3333.stats.st} in ${dt}ms`);

// 7. Weight class shifts st.
const m = solveMaxTotal(highs);
const ll = solveMaxTotal(highs, { weight: 'LL' });
check('LL adds the stamina delta to st',
      ll.stats.st === m.stats.st + (WEIGHT_BASE_ST.LL - WEIGHT_BASE_ST.M),
      `M ${m.stats.st} -> LL ${ll.stats.st}`);

// 8. Bias.
const baseB = solveMaxTotal(highs);
check('positive bias raises mattack',
      solveMaxTotal(highs, { bias: { mattack: 5 } }).stats.mattack > baseB.stats.mattack);
check('negative bias lowers hp',
      solveMaxTotal(highs, { bias: { hp: -5 } }).stats.hp < baseB.stats.hp);
check('hard bound overrides negative bias',
      solveMaxTotal(highs, { bias: { hp: -5 }, bounds: { hp: { min: 4500 } } }).stats.hp >= 4500);

// 9. Pawn.
const pawn = solveMaxTotal(highs, { pawn: true });
const pawnUsed = new Set(['to10', 'to100', 'to200'].flatMap((t) => Object.keys(pawn.counts[t])));
check('pawn uses no hybrid vocations',
      !['mknight', 'assassin', 'marcher'].some((v) => pawnUsed.has(v)));
check('pawn: start has >=1 level in 1->10', (pawn.counts.to10[pawn.start] ?? 0) >= 1);

// 10. Match.
check('exact match: attack === mattack', (() => {
  const r = solveMaxTotal(highs, { match: [{ a: 'attack', b: 'mattack', tol: 0 }] });
  return r.stats.attack === r.stats.mattack;
})());
check('approx match within 10', (() => {
  const r = solveMaxTotal(highs, { match: [{ a: 'defense', b: 'mdefense', tol: 10 }] });
  return Math.abs(r.stats.defense - r.stats.mdefense) <= 10;
})());
check('hp~st match within 100', (() => {
  const r = solveMaxTotal(highs, { match: [{ a: 'hp', b: 'st', tol: 100 }] });
  return Math.abs(r.stats.hp - r.stats.st) <= 100;
})());

// 11. Maximize — lexicographic: hits the stat's max, AND honors other settings.
const MAXES = { hp: 5820, st: 4965, attack: 956, defense: 767, mattack: 866, mdefense: 757 };
for (const k of STATS) {
  const r = solveMaxTotal(highs, { maximize: k });
  check(`maximize ${k} reaches its known max (${MAXES[k]})`, r.stats[k] === MAXES[k],
        `got ${r.stats[k]}`);
}
// Maximize is the TOP priority: it reaches the stat's GLOBAL max first, then the
// other settings apply only among builds that still hit it. Compatible secondary
// settings ARE honored (the max is unaffected): maxing attack to 956 while also
// requiring defense >= 300 and biasing mattack.
const honored = solveMaxTotal(highs, {
  maximize: 'attack',
  bounds: { defense: { min: 300 } },
  bias: { mattack: 5 },
});
check('maximize still hits the max', honored.stats.attack === MAXES.attack,
      `attack ${honored.stats.attack}`);
check('maximize honors a compatible bound', honored.stats.defense >= 300,
      `defense ${honored.stats.defense}`);
// A bound that CONFLICTS with the global max is NOT honored by lowering the
// maximized value — the max is pinned first, so the build is infeasible. (A cap
// on the maximized stat below its global max can never be satisfied at the peak.)
let cappedThrew = false;
try { solveMaxTotal(highs, { maximize: 'attack', bounds: { attack: { max: 500 } } }); }
catch { cappedThrew = true; }
check('maximize + conflicting cap on the maximized stat is infeasible', cappedThrew);
// Likewise a bound on another stat that can't be met at the peak is infeasible,
// rather than settling for a lower maximized value.
let conflictThrew = false;
try { solveMaxTotal(highs, { maximize: 'attack', bounds: { mdefense: { min: 400 } } }); }
catch { conflictThrew = true; }
check('maximize + conflicting bound on another stat is infeasible', conflictThrew);
// Among builds that hit the attack max, the mattack bias should still bend the
// result: biasing mattack up shouldn't lower it vs. no bias.
const noBias = solveMaxTotal(highs, { maximize: 'attack' });
check('secondary objective honored under maximize',
      honored.stats.mattack >= noBias.stats.mattack,
      `mattack ${noBias.stats.mattack} -> ${honored.stats.mattack}`);

// 12. Minimize vocations — uses no more distinct vocations than the default, and
//     no more than the game minimum (start basic + one advanced = 2).
const distinct = (b) =>
  new Set(['to10', 'to100', 'to200'].flatMap((t) => Object.keys(b.counts[t]))).size;
const plain = solveMaxTotal(highs, {});
const minv = solveMaxTotal(highs, { minimizeVocations: true });
check('minimize-vocations uses <= default vocation count',
      distinct(minv) <= distinct(plain), `${distinct(plain)} -> ${distinct(minv)}`);
check('minimize-vocations build is valid (tier sizes)',
      Object.values(minv.counts.to10).reduce((a, n) => a + n, 0) === 9 &&
      Object.values(minv.counts.to100).reduce((a, n) => a + n, 0) === 90 &&
      Object.values(minv.counts.to200).reduce((a, n) => a + n, 0) === 100);
// It's a soft trade-off dominated by vocation count, so its balanced score is
// <= the unconstrained balanced optimum (raw total may differ, since the balanced
// objective discounts hp/st).
const wsc = (b) => STATS.reduce((a, k) => a + BALANCE_WEIGHTS[k] * b.stats[k], 0);
check('minimize-vocations balanced score <= unconstrained',
      wsc(minv) <= wsc(plain) + 1e-6, `${wsc(plain).toFixed(1)} -> ${wsc(minv).toFixed(1)}`);

// 13. Required vocations — { voc: minLevels }: each takes >= its min of the 90 to100.
const rq = solveMaxTotal(highs, { require: { warrior: 40 } });
check('require: warrior gets >=40 of to100', (rq.counts.to100.warrior ?? 0) >= 40,
      `to100 warrior ${rq.counts.to100.warrior ?? 0}`);
const rq90 = solveMaxTotal(highs, { require: { sorcerer: 90 } });
check('require 90 fills to100 with the required voc',
      (rq90.counts.to100.sorcerer ?? 0) === 90, `to100 sorcerer ${rq90.counts.to100.sorcerer ?? 0}`);
// Per-vocation minimums: different amounts for each required vocation.
const rq2 = solveMaxTotal(highs, { require: { warrior: 40, sorcerer: 10 } });
check('require per-voc: warrior >=40 and sorcerer >=10',
      (rq2.counts.to100.warrior ?? 0) >= 40 && (rq2.counts.to100.sorcerer ?? 0) >= 10,
      `warrior ${rq2.counts.to100.warrior ?? 0}, sorcerer ${rq2.counts.to100.sorcerer ?? 0}`);
let reqThrew = false;
try { solveMaxTotal(highs, { require: { warrior: 60, sorcerer: 50 } }); }
catch { reqThrew = true; }
check('require sum 60+50 > 90 is infeasible', reqThrew);
// Require is structural, so it survives the maximize pre-pass.
const rqMax = solveMaxTotal(highs, { maximize: 'mattack', require: { warrior: 30 } });
check('require holds under maximize', (rqMax.counts.to100.warrior ?? 0) >= 30,
      `to100 warrior ${rqMax.counts.to100.warrior ?? 0}`);
// Robustness: a require whose voc isn't in the allowed pool is silently dropped.
const rqDrop = solveMaxTotal(highs, {
  allowed: ALL.filter((v) => v !== 'warrior'), require: { warrior: 90 },
});
check('require for an excluded voc is ignored', rqDrop != null &&
      !Object.keys(rqDrop.counts.to100).includes('warrior'));
const rqPawn = solveMaxTotal(highs, { pawn: true, require: { assassin: 90 } });
check('require for a pawn-excluded hybrid is ignored', (rqPawn.counts.to100.assassin ?? 0) === 0);

// 14. Forced starting class — startPool pins the start to one basic vocation.
for (const s of BASIC) {
  const r = solveMaxTotal(highs, { startPool: [s] });
  check(`forced start ${s}: build.start === ${s}`, r.start === s, `got ${r.start}`);
}
// A forced start still honors other settings (a require on another vocation).
const rqStart = solveMaxTotal(highs, { startPool: ['mage'], require: { warrior: 30 } });
check('forced start honors a require', rqStart.start === 'mage' && (rqStart.counts.to100.warrior ?? 0) >= 30,
      `start ${rqStart.start}, to100 warrior ${rqStart.counts.to100.warrior ?? 0}`);
// Forced start + pawn: the start keeps >=1 of the 1->10 levels.
const startPawn = solveMaxTotal(highs, { startPool: ['fighter'], pawn: true });
check('forced start + pawn: start has >=1 in 1->10',
      startPawn.start === 'fighter' && (startPawn.counts.to10.fighter ?? 0) >= 1,
      `to10 fighter ${startPawn.counts.to10.fighter ?? 0}`);

console.log(`\n${failures ? failures + ' failure(s)' : 'all tests passed'}`);
process.exit(failures ? 1 : 0);
