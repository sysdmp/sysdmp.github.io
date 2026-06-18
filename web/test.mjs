// Test harness for the minimum solver. Uses glpk.js's synchronous Node entry
// (the browser entry runs in a web worker and isn't loadable directly here).
//
// The build objective is linear and separable per tier, so the optimum has a
// closed form: for a given start, each tier takes all its levels in the vocation
// with the highest sum-of-per-level-gains (to10 restricted to basics). That is
// an independent oracle to check the MILP solver against.
//
// Run: node web/test.mjs

import GLPK from 'glpk.js/node';
import { STATS, BASIC, ALL, growth, statsOf, TIER_SIZE } from './data.js';
import { solveMaxTotal } from './solver.js';

const sumGain = (voc, tier) => STATS.reduce((a, k) => a + growth(voc, tier, k), 0);

// Closed-form max-total optimum (the oracle).
function bruteForceOptimum() {
  let best = null;
  for (const start of BASIC) {
    const counts = { to10: {}, to100: {}, to200: {} };
    for (const tier of ['to10', 'to100', 'to200']) {
      const pool = tier === 'to10' ? BASIC : ALL;
      let bv = pool[0], bg = -Infinity;
      for (const v of pool) { const g = sumGain(v, tier); if (g > bg) { bg = g; bv = v; } }
      counts[tier][bv] = TIER_SIZE[tier];
    }
    const stats = statsOf(start, counts);
    const total = STATS.reduce((a, k) => a + stats[k], 0);
    if (!best || total > best.total) best = { start, counts, total };
  }
  return best;
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

const glpk = await GLPK();

// 1. Solver matches the closed-form optimum total.
const oracle = bruteForceOptimum();
const got = await solveMaxTotal(glpk);
check('max-total equals closed-form optimum', got.total === oracle.total,
      `solver ${got.total} vs oracle ${oracle.total}`);

// 2. Returned build's reported stats are self-consistent with statsOf().
const recomputed = statsOf(got.start, got.counts);
check('reported stats match statsOf(counts)',
      STATS.every((k) => recomputed[k] === got.stats[k]));

// 3. Block sizes are respected (9 / 90 / 100).
const tierSum = (t) => Object.values(got.counts[t]).reduce((a, n) => a + n, 0);
check('tier sizes are 9 / 90 / 100',
      tierSum('to10') === 9 && tierSum('to100') === 90 && tierSum('to200') === 100,
      `${tierSum('to10')} / ${tierSum('to100')} / ${tierSum('to200')}`);

// 4. The 1->10 range uses only basic vocations.
check('1->10 uses only basic vocations',
      Object.keys(got.counts.to10).every((v) => BASIC.includes(v)));

// 5. Restricting the pool is honored (no excluded vocation appears).
const restricted = await solveMaxTotal(glpk, { allowed: ALL.filter((v) => v !== 'fighter') });
const used = new Set(['to10', 'to100', 'to200'].flatMap((t) => Object.keys(restricted.counts[t])));
check('allowed-pool restriction excludes fighter', !used.has('fighter'));

console.log(`\n${failures ? failures + ' failure(s)' : 'all tests passed'}`);
process.exit(failures ? 1 : 0);
