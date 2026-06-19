// SPDX-License-Identifier: MIT
// Browser MILP solver for Dragon's Dogma™: Dark Arisen level-200 builds.
//
// Engine: HiGHS (WebAssembly), which has CBC-class cut generation — it solves
// coarse-divisor cases (e.g. st÷3333) that simpler branch-and-bound solvers
// choke on. HiGHS consumes a problem as an LP-format string, so this module
// builds that text.
//
// Model (mirrors the Python prototype's solve_ilp): for each allowed basic START
// vocation, an integer variable per (vocation, tier) counts the level-ups taken
// there; block-size constraints fix the three ranges to 9 / 90 / 100 levels.
// Each stat's final value is base[stat] + a linear function of those counts.
// Objective: a balanced weighted stat total (hp/st discounted to 0.1). Specifiers:
// per-stat bounds, divisor rounding, match, bias, pawn rule, and weight-class
// base stamina. We solve once per start and keep the best feasible build.
//
// HiGHS is MIT-licensed.

import {
  STATS, basic, BASIC, ALL, growth, statsOf, TIER_SIZE,
  WEIGHT_BASE_ST, MAX_GAIN, PAWN_EXCLUDED, BALANCE_WEIGHTS,
} from './data.js';

// Vocations usable in each tier: 1->10 is basics only; later tiers, any.
const tierVocs = (tier, pool) =>
  tier === 'to10' ? pool.filter((v) => BASIC.includes(v)) : pool;

// Decision-variable name for a (tier, vocation) level count. LP-format names must
// avoid '+ - * /' and spaces; tier/vocation keys are already safe identifiers.
const varName = (tier, voc) => `${tier}_${voc}`;

const BIAS_STEP = 0.25;
function statWeight(k, bias) {
  const b = bias?.[k] ?? 0;
  return BALANCE_WEIGHTS[k] + (b * BIAS_STEP) / MAX_GAIN[k];
}

// The (coef, varName) terms of stat k's level-sum expression (zero gains dropped).
function statTerms(stat, pool) {
  const terms = [];
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const v of tierVocs(tier, pool)) {
      const g = growth(v, tier, stat);
      if (g !== 0) terms.push([g, varName(tier, v)]);
    }
  }
  return terms;
}

// Render a list of [coef, name] terms as an LP-format linear expression, e.g.
// "+4 to10_fighter -2 to100_mage". Coefficients are integers here.
function expr(terms) {
  if (terms.length === 0) return '0';
  return terms.map(([c, n]) => `${c >= 0 ? '+' : '-'}${Math.abs(c)} ${n}`).join(' ');
}

// Build the LP-format problem string for one start vocation, or null if a bound
// is trivially unsatisfiable (a stat fixed at base and already out of range).
//
// `objStat`: when set, the objective maximizes that single stat's value (used as
// the first pass of a lexicographic maximize). Otherwise the objective is the
// balanced Σ_k weight(k)*value(k). Either way, ALL the per-stat/match/etc.
// constraints below still apply.
// `pin`: optional { stat, value } — forces value(stat) >= value, used as the
// second pass of a lexicographic maximize to lock in the achieved optimum.
// `minVoc`: when true, add a dominant objective term minimizing the number of
// distinct vocations used (fewer vocation changes), then the balanced total —
// mirrors the prototype's --minimize-vocations. Only meaningful for the balanced
// objective (objStat == null).
function buildLP({ start, pool, bounds, baseSt, bias, pawn, match,
                   objStat = null, pin = null, minVoc = false, noPre10Switch = false }) {
  const base = { ...basic[start].init };
  if (baseSt != null) base.st = baseSt;

  const vars = []; // all (tier,voc) decision variable names
  for (const tier of ['to10', 'to100', 'to200'])
    for (const v of tierVocs(tier, pool)) vars.push(varName(tier, v));

  // A vocation is "used" if it gets any level in any tier. With minVoc we add a
  // binary used_<voc> per vocation and minimize their count as the dominant term.
  const useMinVoc = minVoc && !objStat;
  // distinct vocations that have at least one decision variable in the pool
  const usedVocs = [...new Set(['to10', 'to100', 'to200'].flatMap((t) => tierVocs(t, pool)))];
  const usedVar = (v) => `used_${v}`;
  // dominant penalty per used vocation: larger than any achievable balanced score
  const W_VOC = 1e6;

  // Objective: a single stat's level terms (maximize pass) or the balanced total,
  // optionally minus the used-vocation penalty (minVoc).
  const objTerms = [];
  if (objStat) {
    for (const [g, n] of statTerms(objStat, pool)) {
      objTerms.push(`${g >= 0 ? '+' : '-'}${Math.abs(g)} ${n}`);
    }
  } else {
    for (const tier of ['to10', 'to100', 'to200']) {
      for (const v of tierVocs(tier, pool)) {
        let c = 0;
        for (const k of STATS) c += statWeight(k, bias) * growth(v, tier, k);
        if (c !== 0) objTerms.push(`${c >= 0 ? '+' : '-'}${Math.abs(c)} ${varName(tier, v)}`);
      }
    }
    if (useMinVoc) for (const v of usedVocs) objTerms.push(`- ${W_VOC} ${usedVar(v)}`);
  }

  const cons = []; // constraint lines
  const extraInts = []; // divisor multiplier integer vars
  const boundLines = []; // explicit variable bound lines
  const binaries = []; // 0/1 vars (used-vocation indicators)

  // Block-size constraints: each tier's counts sum to its fixed size.
  for (const tier of ['to10', 'to100', 'to200']) {
    const t = tierVocs(tier, pool).map((v) => `+ ${varName(tier, v)}`).join(' ');
    cons.push(`sz_${tier}: ${t} = ${TIER_SIZE[tier]}`);
  }

  // minVoc: link each tier variable to its vocation's used_<voc> binary
  // (x <= tier_size * used  =>  x - tier_size used <= 0), so used=1 whenever the
  // vocation gets any level.
  if (useMinVoc) {
    for (const v of usedVocs) binaries.push(usedVar(v));
    for (const tier of ['to10', 'to100', 'to200']) {
      for (const v of tierVocs(tier, pool)) {
        cons.push(`use_${tier}_${v}: + ${varName(tier, v)} - ${TIER_SIZE[tier]} ${usedVar(v)} <= 0`);
      }
    }
  }

  // Pawn: >=1 of the 1->10 levels in the starting vocation.
  if (pawn) cons.push(`pawn: + ${varName('to10', start)} >= 1`);

  // No pre-10 switch: all 9 of the 1->10 levels stay in the start vocation
  // (you can't change vocation before level 10 without the Hard Mode trick).
  if (noPre10Switch) cons.push(`nopre10: + ${varName('to10', start)} = ${TIER_SIZE.to10}`);

  // Lexicographic-maximize pin: value(stat) >= achieved optimum.
  if (pin) {
    const terms = statTerms(pin.stat, pool);
    const rhs = pin.value - base[pin.stat];
    if (terms.length === 0) { if (rhs > 0) return null; } // stat fixed at base
    else cons.push(`pin_${pin.stat}: ${expr(terms)} >= ${rhs}`);
  }

  // Per-stat min/max/divisor constraints. value(k) = base[k] + Σ terms.
  for (const k of STATS) {
    const b = bounds?.[k];
    if (!b) continue;
    const lo = b.min == null ? null : b.min - base[k];
    const hi = b.max == null ? null : b.max - base[k];
    const terms = statTerms(k, pool);
    const divisor = b.divisor ?? null;

    if (terms.length === 0) {
      // stat fixed at base[k]; decide feasibility directly
      if (lo != null && 0 < lo) return null;
      if (divisor != null) { if (base[k] % divisor !== 0) return null; }
      else if (hi != null && 0 > hi) return null;
      continue;
    }

    if (divisor != null) {
      // value = divisor*mult: Σ terms - divisor*mult = -base[k], mult integer >= 0
      const mult = `mult_${k}`;
      extraInts.push(mult);
      cons.push(`div_${k}: ${expr(terms)} - ${divisor} ${mult} = ${-base[k]}`);
      if (lo != null) cons.push(`floor_${k}: ${expr(terms)} >= ${lo}`);
      continue; // max dropped under divisor mode
    }

    if (lo != null && hi != null && lo === hi) cons.push(`eq_${k}: ${expr(terms)} = ${lo}`);
    else {
      if (lo != null) cons.push(`lo_${k}: ${expr(terms)} >= ${lo}`);
      if (hi != null) cons.push(`hi_${k}: ${expr(terms)} <= ${hi}`);
    }
  }

  // Match: |value(a) - value(b)| <= tol  ->  Σ(terms_a - terms_b) in [-tol-c, tol-c]
  // where c = base[a]-base[b]. Combine terms by variable.
  let mi = 0;
  for (const { a, b, tol } of match) {
    const c = base[a] - base[b];
    const coefs = {};
    for (const [g, n] of statTerms(a, pool)) coefs[n] = (coefs[n] || 0) + g;
    for (const [g, n] of statTerms(b, pool)) coefs[n] = (coefs[n] || 0) - g;
    const terms = Object.entries(coefs).filter(([, g]) => g !== 0).map(([n, g]) => [g, n]);
    if (terms.length === 0) {
      if (Math.abs(c) > tol) return null;
      continue;
    }
    const e = expr(terms);
    if (tol === 0) cons.push(`match_${mi++}: ${e} = ${-c}`);
    else {
      cons.push(`matchlo_${mi}: ${e} >= ${-tol - c}`);
      cons.push(`matchhi_${mi}: ${e} <= ${tol - c}`);
      mi++;
    }
  }

  // Default count vars have a natural upper bound (their tier size); declaring it
  // helps the solver and keeps them non-negative integers.
  for (const tier of ['to10', 'to100', 'to200'])
    for (const v of tierVocs(tier, pool))
      boundLines.push(`0 <= ${varName(tier, v)} <= ${TIER_SIZE[tier]}`);
  for (const m of extraInts) boundLines.push(`0 <= ${m}`);

  return [
    'Maximize',
    ` obj: ${objTerms.join(' ') || '0'}`,
    'Subject To',
    ...cons.map((c) => ` ${c}`),
    'Bounds',
    ...boundLines.map((b) => ` ${b}`),
    'General',
    ` ${[...vars, ...extraInts].join(' ')}`,
    ...(binaries.length ? ['Binary', ` ${binaries.join(' ')}`] : []),
    'End',
  ].join('\n');
}

// Read a HiGHS solution's column values into per-tier count maps.
function decode(sol, pool) {
  const counts = { to10: {}, to100: {}, to200: {} };
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const v of tierVocs(tier, pool)) {
      const col = sol.Columns[varName(tier, v)];
      const n = col ? Math.round(col.Primal || 0) : 0;
      if (n > 0) counts[tier][v] = n;
    }
  }
  return counts;
}

/**
 * Solve for the build maximizing the balanced stat objective.
 *
 * @param {object} highs   an initialized HiGHS instance (await highsLoader(...)).
 * @param {object} [opts]
 * @param {string[]} [opts.allowed]   vocations usable in any range (default: all).
 * @param {string[]} [opts.startPool] allowed basic start vocations (default: all basics).
 * @param {object} [opts.bounds]      per-stat { min, max, divisor } (any may be null/omitted);
 *                                    min === max requests an exact value; a divisor forces a
 *                                    multiple (value = divisor*k), dropping max, keeping min.
 * @param {object} [opts.bias]        per-stat integer bias (− deprioritize / + favor; 0 neutral).
 *                                    A soft objective adjustment, never overrides a bound.
 * @param {boolean} [opts.pawn]       build for a pawn: exclude hybrid vocations and require
 *                                    ≥1 of the 1→10 levels in the starting vocation.
 * @param {Array} [opts.match]        stat pairs { a, b, tol }; |value(a)−value(b)| ≤ tol
 *                                    (tol 0 = exact equality). A hard constraint.
 * @param {string} [opts.weight]      weight class (SS/S/M/L/LL); sets level-1 stamina.
 * @param {string} [opts.maximize]    a single stat to maximize as the TOP priority,
 *                                    lexicographically: first maximize it to its GLOBAL
 *                                    optimum over the structural build space only (pool,
 *                                    pawn, weight, no-switcheroo) — the per-stat bounds and
 *                                    match are NOT applied in this pass, so they can't lower
 *                                    the peak. That peak is pinned, then the bounds/match and
 *                                    the balanced objective apply among builds that still hit
 *                                    it. A bound that conflicts with the peak makes the build
 *                                    infeasible (rather than settling for a lower maximum).
 * @param {boolean} [opts.minimizeVocations] prefer builds using fewer distinct
 *                                    vocations (fewer vocation changes) as the dominant
 *                                    objective term, then the balanced total. May yield
 *                                    a lower stat total.
 * @param {boolean} [opts.noPre10Switch] forbid changing vocation before level 10:
 *                                    all nine 1→10 levels stay in the start vocation.
 * @returns {{start, counts, stats, total}} the best feasible build.
 * @throws if no allowed build satisfies the constraints.
 */
export function solveMaxTotal(highs, opts = {}) {
  let pool = opts.allowed ?? ALL;
  if (opts.pawn) pool = pool.filter((v) => !PAWN_EXCLUDED.includes(v));
  const starts = (opts.startPool ?? BASIC).filter((v) => pool.includes(v));
  const bounds = opts.bounds ?? {};
  const bias = opts.bias ?? {};
  const match = opts.match ?? [];
  const maximize = opts.maximize ?? null;
  const minVoc = !!opts.minimizeVocations;
  const noPre10Switch = !!opts.noPre10Switch;
  const baseSt = opts.weight != null ? WEIGHT_BASE_ST[opts.weight] : null;

  // Force HiGHS to prove true optimality. Its default MIP gap (~0.01% relative)
  // lets it stop early on a near-optimal incumbent — which here can mean leaving
  // a fractional hp/st point on the table vs. the exact optimum. Zero gaps make
  // it match the prototype's exact solve.
  const SOLVE_OPTS = { mip_rel_gap: 0, mip_abs_gap: 0 };

  // Distinct vocations a build actually uses (any level in any tier).
  const vocCount = (counts) =>
    new Set(['to10', 'to100', 'to200'].flatMap((t) => Object.keys(counts[t] || {}))).size;

  // The per-start model config shared by both passes; objStat/pin vary per pass.
  const modelBase = { pool, bounds, baseSt, bias, pawn: opts.pawn, match, minVoc, noPre10Switch };

  const solve = (objStat, pin, override = {}) => {
    const results = [];
    for (const start of starts) {
      const lp = buildLP({ ...modelBase, ...override, start, objStat, pin });
      if (lp === null) continue; // trivially infeasible for this start
      const sol = highs.solve(lp, SOLVE_OPTS);
      if (sol.Status !== 'Optimal') continue; // Infeasible / Unbounded -> skip
      const counts = decode(sol, pool);
      const stats = statsOf(start, counts, baseSt);
      results.push({ start, counts, stats });
    }
    return results;
  };

  // Without --maximize: a single balanced solve, best start by the biased total.
  // With --maximize: lexicographic, and maximize is the TOP priority. Pass 1 finds
  // the stat's GLOBAL maximum over the structural build space only (pool, pawn,
  // weight, no-switcheroo) — deliberately ignoring the per-stat bounds and match,
  // so those can't quietly lower the achieved peak. Pass 2 pins that peak and then
  // applies every bound/match: if a target can't be met without dropping below the
  // peak, no candidate survives and the build is infeasible (rather than settling
  // for a smaller maximized value).
  let candidates;
  if (maximize) {
    const pass1 = solve(maximize, null, { bounds: {}, match: [] });
    if (pass1.length === 0) throw new Error('no build satisfies these constraints');
    const maxVal = Math.max(...pass1.map((r) => r.stats[maximize]));
    candidates = solve(null, { stat: maximize, value: maxVal });
    if (candidates.length === 0) throw new Error('no build satisfies these constraints');
  } else {
    candidates = solve(null, null);
    if (candidates.length === 0) throw new Error('no build satisfies these constraints');
  }

  // Rank candidates. With minimize-vocations, the dominant key is the distinct-
  // vocation count (fewer is better); the balanced (biased) score breaks ties.
  // Otherwise rank by the balanced score alone. The maximize pin (if any) already
  // guaranteed the top-priority stat is at its optimum for every candidate.
  let best = null;
  for (const c of candidates) {
    const total = STATS.reduce((a, k) => a + c.stats[k], 0);
    const score = STATS.reduce((a, k) => a + statWeight(k, bias) * c.stats[k], 0);
    const nVoc = minVoc ? vocCount(c.counts) : 0;
    const better = !best
      || (minVoc && nVoc < best.nVoc)
      || ((!minVoc || nVoc === best.nVoc) && score > best.score);
    if (better) best = { ...c, total, score, nVoc };
  }
  delete best.score;
  delete best.nVoc;
  return best;
}
