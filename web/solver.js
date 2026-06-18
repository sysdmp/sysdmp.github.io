// Minimum browser MILP solver for Dragon's Dogma: Dark Arisen level-200 builds.
//
// This is the absolute-minimum starting point: it maximizes the total stat sum
// (all six stats, equal weight) with NO specifiers — no min/max, divisor, nice,
// match, bias, or maximize/minimize. Those are layered on later.
//
// Model (mirrors the prototype's solve_ilp, stripped to the core): for each
// allowed basic START vocation, an integer variable per (vocation, tier) counts
// the level-ups taken there. Block-size constraints fix the three ranges to
// 9 / 90 / 100 levels. The objective maximizes sum over stats of the final
// value, which is a linear function of those counts. We solve once per start
// and keep the best.
//
// Uses glpk.js (GPLv3-or-later); this module is therefore GPLv3-or-later.

import { STATS, basic, BASIC, ALL, growth, statsOf, TIER_SIZE } from './data.js';

// Vocations usable in each tier: 1->10 is basics only; later tiers, any.
const tierVocs = (tier, pool) =>
  tier === 'to10' ? pool.filter((v) => BASIC.includes(v)) : pool;

// Build the glpk LP/MILP object for one start vocation, maximizing total stats.
function buildModel(glpk, start, pool) {
  const varName = (tier, voc) => `${tier}__${voc}`;
  const vars = []; // every (tier, voc) decision variable name
  const subjectTo = [];

  // Block-size constraint per tier: sum of its counts == tier size.
  for (const tier of ['to10', 'to100', 'to200']) {
    const vocs = tierVocs(tier, pool);
    const terms = vocs.map((v) => {
      const name = varName(tier, v);
      vars.push(name);
      return { name, coef: 1.0 };
    });
    subjectTo.push({
      name: `size_${tier}`,
      vars: terms,
      bnds: { type: glpk.GLP_FX, lb: TIER_SIZE[tier], ub: TIER_SIZE[tier] },
    });
  }

  // Objective: maximize sum over stats of final value. The start vocation's
  // init is a constant (dropped from the objective; added back when reporting).
  // Each variable's objective coef is the sum over stats of its per-level gain.
  const objVars = [];
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const v of tierVocs(tier, pool)) {
      let coef = 0;
      for (const k of STATS) coef += growth(v, tier, k);
      objVars.push({ name: varName(tier, v), coef });
    }
  }

  return {
    name: `build_${start}`,
    objective: { direction: glpk.GLP_MAX, name: 'total', vars: objVars },
    subjectTo,
    generals: vars, // all decision variables are non-negative integers
  };
}

// Decode glpk's result vars back into per-tier count maps.
function decode(result, pool) {
  const counts = { to10: {}, to100: {}, to200: {} };
  const vals = result.result.vars;
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const v of tierVocs(tier, pool)) {
      const n = Math.round(vals[`${tier}__${v}`] || 0);
      if (n > 0) counts[tier][v] = n;
    }
  }
  return counts;
}

/**
 * Solve for the build maximizing total stat sum.
 *
 * @param {object} glpk        an initialized glpk.js instance (await GLPK()).
 * @param {object} [opts]
 * @param {string[]} [opts.allowed]    vocations usable in any range (default ALL).
 * @param {string[]} [opts.startPool]  allowed basic start vocations (default BASIC).
 * @returns {Promise<{start, counts, stats, total}>} the best build found.
 */
export async function solveMaxTotal(glpk, opts = {}) {
  const pool = opts.allowed ?? ALL;
  const starts = (opts.startPool ?? BASIC).filter((v) => pool.includes(v));

  let best = null;
  for (const start of starts) {
    const model = buildModel(glpk, start, pool);
    const res = await glpk.solve(model, { msglev: glpk.GLP_MSG_OFF });
    if (res.result.status !== glpk.GLP_OPT) continue;

    const counts = decode(res, pool);
    const stats = statsOf(start, counts);
    const total = STATS.reduce((a, k) => a + stats[k], 0);
    if (!best || total > best.total) best = { start, counts, stats, total };
  }
  if (!best) throw new Error('no feasible build (unexpected for the unconstrained problem)');
  return best;
}
