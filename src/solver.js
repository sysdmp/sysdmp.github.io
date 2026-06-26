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
  STATS, basic, BASIC, ALL, growth, statsOf, TIERS, TIER_SIZE,
  WEIGHT_BASE_ST, MAX_GAIN, PAWN_EXCLUDED, BALANCE_WEIGHTS,
  BIAS_BOOST_BASE, BIAS_BOOST_FALLOFF, OBJ_SCALE, TIEBREAK_ORDER,
} from './data.js';

// Vocations usable in each tier: 1->10 is basics only; later tiers, any.
const tierVocs = (tier, pool) =>
  tier === 'to10' ? pool.filter((v) => BASIC.includes(v)) : pool;

// Normalize a per-tier require map { to10:{voc:n}, to100:{...}, to200:{...} } against
// the allowed pool: drop entries whose vocation can't be leveled in that tier (not in
// the pool, or not a basic for to10), and clamp each minimum to 1..tier-size. Returns
// a fresh { to10, to100, to200 } so a missing/partial input is safe.
function normalizeRequire(require, pool) {
  const out = { to10: {}, to100: {}, to200: {} };
  for (const tier of TIERS) {
    const usable = new Set(tierVocs(tier, pool));
    for (const [v, n] of Object.entries(require?.[tier] || {})) {
      if (usable.has(v)) out[tier][v] = Math.max(1, Math.min(TIER_SIZE[tier], Math.round(n)));
    }
  }
  return out;
}

// Decision-variable name for a (tier, vocation) level count. LP-format names must
// avoid '+ - * /' and spaces; tier/vocation keys are already safe identifiers.
const varName = (tier, voc) => `${tier}_${voc}`;

// --- bias model (ported from the Python prototype's "equal-share floor then
// maximize"). The UI gives a per-stat integer (−5..+5); we read its MAGNITUDE as a
// tier rank: among positively-biased stats the highest value is tier 0 (favored
// most), the next distinct value tier 1, etc.; equal values share a tier (equal
// share). Negatives are tiered independently by magnitude. ---

// {stat:int} -> ordered [{sign, stats:[...]}] (positive tiers high→low value, then
// negative tiers high→low magnitude; equal magnitudes grouped into one tier).
export function biasTiersFromMap(bias) {
  const tiers = [];
  for (const sign of [1, -1]) {
    const byMag = new Map(); // magnitude -> [stats]
    for (const k of STATS) {
      const b = bias?.[k] ?? 0;
      if (Math.sign(b) !== sign) continue;
      const mag = Math.abs(b);
      if (!byMag.has(mag)) byMag.set(mag, []);
      byMag.get(mag).push(k);
    }
    for (const mag of [...byMag.keys()].sort((a, b) => b - a)) {
      tiers.push({ sign, stats: byMag.get(mag) });
    }
  }
  return tiers;
}

// tiers -> { stat: {sign, idx} }, idx = 0-based position within that sign's tiers
// (positive and negative indexed independently — mirrors Python's bias_ranks).
export function biasRanks(tiers) {
  const ranks = {};
  let posI = 0, negI = 0;
  for (const { sign, stats } of tiers) {
    const idx = sign > 0 ? posI++ : negI++;
    for (const k of stats) ranks[k] = { sign, idx };
  }
  return ranks;
}

// The balanced objective's per-stat weights, scaled to integers by OBJ_SCALE (so
// HiGHS and CBC compute identical objective values — see data.js). No bias.
function baseWeights() {
  const w = {};
  for (const k of STATS) w[k] = Math.round(OBJ_SCALE * BALANCE_WEIGHTS[k]);
  return w;
}

// Per-stat objective weight (integer, OBJ_SCALE'd): the balance weight plus the bias
// adjustment (sign * BASE * FALLOFF**idx / MAX_GAIN[k]); both signs adjust the weight.
export function effWeights(ranks) {
  const w = baseWeights();
  for (const [k, { sign, idx }] of Object.entries(ranks)) {
    w[k] += Math.round(sign * OBJ_SCALE * BIAS_BOOST_BASE * (BIAS_BOOST_FALLOFF ** idx) / MAX_GAIN[k]);
  }
  return w;
}

// Positive tiers only: [{stat, share: FALLOFF**idx}] for the equal-share floor pass.
function biasShares(ranks) {
  return Object.entries(ranks)
    .filter(([, r]) => r.sign > 0)
    .map(([k, r]) => ({ stat: k, share: BIAS_BOOST_FALLOFF ** r.idx }));
}

// The (coef, varName) terms of stat k's level-sum expression (zero gains dropped).
function statTerms(stat, pool) {
  const terms = [];
  for (const tier of TIERS) {
    for (const v of tierVocs(tier, pool)) {
      const g = growth(v, tier, stat);
      if (g !== 0) terms.push([g, varName(tier, v)]);
    }
  }
  return terms;
}

// Render one LP-format term, e.g. fmtTerm(-2, 'to100_mage') -> "-2 to100_mage".
const fmtTerm = (c, name) => `${c >= 0 ? '+' : '-'}${Math.abs(c)} ${name}`;

// Render a list of [coef, name] terms as an LP-format linear expression, e.g.
// "+4 to10_fighter -2 to100_mage". Coefficients are integers here.
function expr(terms) {
  if (terms.length === 0) return '0';
  return terms.map(([c, n]) => fmtTerm(c, n)).join(' ');
}

// Build the LP-format problem string for one start vocation, or null if a bound
// is trivially unsatisfiable (a stat fixed at base and already out of range).
//
// `objStat`: a stat name maximizes that single stat (lexicographic maximize pass);
// the sentinel 'bias_t' maximizes the continuous bias-floor variable; null uses the
// balanced Σ_k effW(k)*value(k). Either way, ALL the per-stat/match/etc. constraints
// below still apply.
// `pins`: optional list of { stat, value, op } — constrains value(stat) op value
// (op '>=' floors a lexicographic-maximize optimum; '=' locks a resolved tie-break
// stat; defaults to '>='). Used by the maximize and tie-break passes.
// `scoreFloor`: optional { value } — floors the balanced objective Σ effW(k)·value(k)
// at `value`, so a tie-break pass can't trade primary score for a favored stat.
// `effW`: the per-stat (integer, OBJ_SCALE'd) objective weights for the balanced
// objective. `shares`: [{stat, share}] for the bias-floor pass (objStat === 'bias_t').
// `floors`: { stat: minValue } baked-in bias floors (final solve).
function buildLP({ start, pool, bounds, baseSt, pawn, match,
                   objStat = null, pins = [], scoreFloor = null, noPre10Switch = false,
                   reqVocs = {}, effW = null, shares = [], floors = null,
                   nogoods = [] }) {
  if (effW == null) effW = baseWeights();
  const base = { ...basic[start].init };
  if (baseSt != null) base.st = baseSt;

  const vars = []; // all (tier,voc) decision variable names
  for (const tier of TIERS)
    for (const v of tierVocs(tier, pool)) vars.push(varName(tier, v));

  const biasTMode = objStat === 'bias_t';

  // Objective: a single stat's level terms (lexicographic maximize pass), the bias
  // floor variable bias_t (maximize-t pass), or the balanced eff-weighted total.
  const objTerms = [];
  if (biasTMode) {
    objTerms.push('+ 1 bias_t');
  } else if (objStat) {
    for (const [g, n] of statTerms(objStat, pool)) objTerms.push(fmtTerm(g, n));
  } else {
    for (const tier of TIERS) {
      for (const v of tierVocs(tier, pool)) {
        let c = 0;
        for (const k of STATS) c += effW[k] * growth(v, tier, k);
        if (c !== 0) objTerms.push(fmtTerm(c, varName(tier, v)));
      }
    }
  }

  const cons = []; // constraint lines
  const extraInts = []; // divisor multiplier integer vars
  const boundLines = []; // explicit variable bound lines
  const binaries = []; // 0/1 vars (no-good cut g/l indicators)

  // Bias-floor pass: maximize a continuous bias_t s.t. value(stat) >= share*MAX_GAIN*t
  // for each positively-biased stat, i.e. Σterms_k - share*MAX_GAIN[k]*bias_t >= -base[k].
  // The bias_t coefficient is fractional, so it's formatted directly (not via expr,
  // which assumes integer coefficients). bias_t is continuous (Bounds only, not General).
  if (biasTMode) {
    for (const { stat, share } of shares) {
      const coef = share * MAX_GAIN[stat];
      const terms = statTerms(stat, pool);
      // value(stat) = base + Σterms; if no terms, the floor share*MAX_GAIN*t must be
      // <= base, which only bounds t — harmless, skip (t is bounded by other stats).
      if (terms.length === 0) continue;
      cons.push(`share_${stat}: ${expr(terms)} - ${coef.toFixed(6)} bias_t >= ${-base[stat]}`);
    }
    boundLines.push('0 <= bias_t');
  }

  // Baked bias floors (final solve): value(stat) >= floorval  ->  Σterms >= floorval-base.
  if (floors) {
    for (const [k, floorval] of Object.entries(floors)) {
      const terms = statTerms(k, pool);
      const rhs = floorval - base[k];
      if (terms.length === 0) { if (rhs > 0) return null; } // stat fixed at base, floor unreachable
      else cons.push(`biasfloor_${k}: ${expr(terms)} >= ${rhs}`);
    }
  }

  // Block-size constraints: each tier's counts sum to its fixed size.
  for (const tier of TIERS) {
    const t = tierVocs(tier, pool).map((v) => `+ ${varName(tier, v)}`).join(' ');
    cons.push(`sz_${tier}: ${t} = ${TIER_SIZE[tier]}`);
  }

  // Pawn: >=1 of the 1->10 levels in the starting vocation.
  if (pawn) cons.push(`pawn: + ${varName('to10', start)} >= 1`);

  // No pre-10 switch: all 9 of the 1->10 levels stay in the start vocation
  // (you can't change vocation before level 10 without the Hard Mode trick).
  if (noPre10Switch) cons.push(`nopre10: + ${varName('to10', start)} = ${TIER_SIZE.to10}`);

  // Required vocations: per tier, each listed vocation takes >= its minimum of that
  // tier's levels. (A per-tier sum of minimums > the tier size is naturally infeasible
  // via the block-size constraint; the UI validates that case for a clear message.)
  for (const tier of TIERS) {
    for (const [v, n] of Object.entries(reqVocs[tier] || {})) {
      cons.push(`require_${tier}_${v}: + ${varName(tier, v)} >= ${n}`);
    }
  }

  // Lexicographic pins: value(stat) op achieved optimum. op '>=' floors a maximize
  // optimum; '=' locks a resolved tie-break stat at its exact value.
  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const op = p.op || '>=';
    const terms = statTerms(p.stat, pool);
    const rhs = p.value - base[p.stat];
    if (terms.length === 0) {
      // stat fixed at base: feasible only if base already satisfies the relation
      if (op === '>=' ? 0 < rhs : 0 !== rhs) return null;
    } else {
      cons.push(`pin${i}_${p.stat}: ${expr(terms)} ${op} ${rhs}`);
    }
  }

  // Balanced-score floor: Σ effW(k)·value(k) >= value. value(k) = base[k] + Σ terms,
  // so Σ_k effW[k]·Σterms_k >= value - Σ_k effW[k]·base[k]. Integer coefficients
  // (effW is OBJ_SCALE'd). Lets a tie-break pass hold the primary optimum fixed.
  if (scoreFloor) {
    const coef = {};
    for (const k of STATS)
      for (const [g, n] of statTerms(k, pool)) coef[n] = (coef[n] || 0) + effW[k] * g;
    const terms = Object.entries(coef).filter(([, g]) => g !== 0).map(([n, g]) => [g, n]);
    const rhs = scoreFloor.value - STATS.reduce((a, k) => a + effW[k] * base[k], 0);
    if (terms.length === 0) { if (rhs > 0) return null; }
    else cons.push(`scorefloor: ${expr(terms)} >= ${rhs}`);
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

  // No-good cuts: each entry is a prior allocation { 'tier_voc': count } to exclude,
  // so the solver must return a DIFFERENT allocation. For every decision var x with
  // recorded value v, add binaries g (x >= v+1) and l (x <= v-1) and require their
  // sum over all vars >= 1 — i.e. at least one var differs. (Mirrors the Python
  // prototype's enumeration cuts.)
  nogoods.forEach((alloc, ci) => {
    const inds = [];
    for (const tier of TIERS) {
      const U = TIER_SIZE[tier];
      for (const v of tierVocs(tier, pool)) {
        const name = varName(tier, v);
        const vi = alloc[name] || 0;
        const g = `ng${ci}_g_${name}`, l = `ng${ci}_l_${name}`;
        binaries.push(g, l);
        // g=1 => x >= vi+1 :  x - (vi+1) g >= 0  (when g=0, x>=0 trivially)
        cons.push(`ngg_${ci}_${name}: + ${name} - ${vi + 1} ${g} >= 0`);
        // l=1 => x <= vi-1 :  x + (U - vi + 1) l <= U  (when l=0, x<=U trivially)
        cons.push(`ngl_${ci}_${name}: + ${name} + ${U - vi + 1} ${l} <= ${U}`);
        inds.push(`+ ${g}`, `+ ${l}`);
      }
    }
    cons.push(`ngsum_${ci}: ${inds.join(' ')} >= 1`);
  });

  // Default count vars have a natural upper bound (their tier size); declaring it
  // helps the solver and keeps them non-negative integers.
  for (const tier of TIERS)
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
  for (const tier of TIERS) {
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
 * @param {object} [opts.bias]        per-stat integer bias (−5..+5; − deprioritize / + favor;
 *                                    0 neutral). The magnitude is a tier rank: among favored
 *                                    stats the highest value is favored most; equal values share
 *                                    a tier (equal share). Positively-biased stats get a hard
 *                                    "equal-share floor" so they're guaranteed to grow — earlier
 *                                    tiers more — then the eff-weighted total maximizes within.
 *                                    Mirrors the Python prototype's --bias.
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
 * @param {boolean} [opts.noPre10Switch] forbid changing vocation before level 10:
 *                                    all nine 1→10 levels stay in the start vocation.
 * @param {object} [opts.require] per-tier, per-vocation minimum level counts:
 *                                    { to10: {voc:n}, to100: {voc:n}, to200: {voc:n} }.
 *                                    Each listed vocation must take ≥ n of that tier's
 *                                    levels (tier sizes 9 / 90 / 100; clamped). Entries
 *                                    whose voc can't be leveled in the tier (not allowed,
 *                                    pawn-dropped hybrid, or a non-basic in 1→10) are
 *                                    dropped. A hard constraint (structural: applies in
 *                                    the maximize pre-pass too). A per-tier sum exceeding
 *                                    the tier size is infeasible.
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
  const noPre10Switch = !!opts.noPre10Switch;
  const baseSt = opts.weight != null ? WEIGHT_BASE_ST[opts.weight] : null;
  // Required vocations, per tier: each listed vocation must take >= its minimum of that
  // tier's levels. Normalized against the pool (drops vocations not usable in a tier —
  // excluded, pawn-dropped hybrids, or non-basics in 1->10 — and clamps to tier size).
  const reqVocs = normalizeRequire(opts.require, pool);

  // Force HiGHS to prove true optimality. Its default MIP gap (~0.01% relative)
  // lets it stop early on a near-optimal incumbent — which here can mean leaving
  // a fractional hp/st point on the table vs. the exact optimum. Zero gaps make
  // it match the prototype's exact solve.
  const SOLVE_OPTS = { mip_rel_gap: 0, mip_abs_gap: 0 };

  // Bias: derive the tier structure from the per-stat {stat:int} map, then the
  // effective objective weights and the positive-tier shares for the floor pass.
  const ranks = biasRanks(biasTiersFromMap(bias));
  const effW = effWeights(ranks);
  const shares = biasShares(ranks);

  // The per-start model config; objStat/pin/floors vary per pipeline stage.
  const modelBase = { pool, bounds, baseSt, pawn: opts.pawn, match, noPre10Switch,
                      reqVocs, effW };

  const solveLP = (extra) => {
    const lp = buildLP({ ...modelBase, ...extra });
    if (lp === null) return null;
    const sol = highs.solve(lp, SOLVE_OPTS);
    return sol.Status === 'Optimal' ? sol : null;
  };

  // The integer balanced score of a stat vector (matches the LP objective exactly).
  const scoreOf = (stats) => STATS.reduce((a, k) => a + effW[k] * stats[k], 0);

  // Per-start pipeline mirroring the Python prototype: maximize pin (structural-only)
  // -> bias-floor t maximization (positive tiers) -> bake integer floors -> final
  // eff-weighted solve -> deterministic tie-break. Returns a candidate or null.
  const solveStart = (start) => {
    // 1. Lexicographic maximize pin: the chosen stat's global optimum over the
    //    structural build space only (no bounds/match), pinned for the later passes.
    const pins = [];
    let lexOpt = null;
    if (maximize) {
      const sol = solveLP({ start, objStat: maximize, bounds: {}, match: [] });
      if (!sol) return null;
      const peak = Math.round(statsOf(start, decode(sol, pool), baseSt)[maximize]);
      pins.push({ stat: maximize, value: peak, op: '>=' });
      lexOpt = peak;
    }

    // 2. Bias-floor pass: maximize a shared t s.t. each positively-biased stat is
    //    >= share*MAX_GAIN*t, carrying the pin + bounds/match. Then bake integer
    //    floors. Skipped when there are no positive tiers.
    let floors = null;
    if (shares.length) {
      const sol = solveLP({ start, objStat: 'bias_t', pins, shares });
      if (!sol) return null;
      const t = sol.Columns.bias_t?.Primal ?? 0;
      floors = {};
      for (const { stat, share } of shares) {
        floors[stat] = Math.floor(share * MAX_GAIN[stat] * t);
      }
    }

    // 3. Final solve: balanced eff-weighted objective, pins, bounds/match, baked
    //    floors. Fixes the optimal SCORE (but the stat-vector may be a degenerate tie).
    let sol = solveLP({ start, objStat: null, pins, floors });
    if (!sol) return null;
    const optScore = scoreOf(statsOf(start, decode(sol, pool), baseSt));

    // 4. Deterministic tie-break: hold the optimal score as a floor, then maximize
    //    each TIEBREAK_ORDER stat in turn, locking the achieved value. This collapses
    //    the degenerate optima to one canonical stat-vector that any exact MILP engine
    //    reaches — so the web (HiGHS) and Python (CBC) solvers agree on the stats.
    const scoreFloor = { value: optScore };
    const lockPins = [...pins];   // pins so far stay in force; tie-break locks append
    for (const stat of TIEBREAK_ORDER) {
      const s = solveLP({ start, objStat: stat, pins: lockPins, scoreFloor, floors });
      if (!s) return null;        // score floor + prior locks always remain feasible
      const val = Math.round(statsOf(start, decode(s, pool), baseSt)[stat]);
      lockPins.push({ stat, value: val, op: '=' });
      sol = s;
    }

    const counts = decode(sol, pool);
    const stats = statsOf(start, counts, baseSt);
    return { start, counts, stats, lexOpt, score: optScore };
  };

  const candidates = starts.map(solveStart).filter(Boolean);
  if (candidates.length === 0) throw new Error('no build satisfies these constraints');

  // Rank across starts deterministically (mirrors Python's quality key): the
  // maximized stat's value (higher better — selects the global-max start), then the
  // eff-weighted score, then the SAME combat-first tie-break order. The final key
  // makes the chosen start independent of which engine solves it, just like the
  // per-start tie-break makes the stat-vector independent of the engine.
  const better = (c, b) => {
    if (maximize && c.lexOpt !== b.lexOpt) return c.lexOpt > b.lexOpt;
    if (c.score !== b.score) return c.score > b.score;
    for (const k of TIEBREAK_ORDER) if (c.stats[k] !== b.stats[k]) return c.stats[k] > b.stats[k];
    return false;
  };
  let best = null;
  for (const c of candidates) if (!best || better(c, best)) best = c;
  best = { ...best, total: STATS.reduce((a, k) => a + best.stats[k], 0) };
  delete best.score;
  delete best.lexOpt;
  return best;
}

// Flatten a per-tier counts map into the { 'tier_voc': n } form the no-good cuts use.
function flatAlloc(counts) {
  const a = {};
  for (const tier of TIERS)
    for (const [v, n] of Object.entries(counts[tier] || {})) a[varName(tier, v)] = n;
  return a;
}

/**
 * Lazily yield builds that reach the EXACT same six final stats as a solved build,
 * one at a time, each via a distinct vocation/level allocation (and possibly a
 * different starting vocation). Pins every stat to equality and walks distinct
 * allocations across all allowed starts using no-good cuts — yielding after each so
 * the caller controls how many to compute (each is one blocking HiGHS solve).
 *
 * @param {object} highs   initialized HiGHS instance.
 * @param {object} opts    the same options passed to solveMaxTotal (pool/pawn/weight/
 *                         require/startPool/no-switcheroo are honored; bounds/match/
 *                         bias/maximize are irrelevant once all stats are pinned).
 * @param {object} stats   the target final stats { hp, st, ... } to match exactly.
 * @yields {{start, counts, stats}} each distinct same-stats build.
 */
export function* sameStatsBuilds(highs, opts = {}, stats) {
  let pool = opts.allowed ?? ALL;
  if (opts.pawn) pool = pool.filter((v) => !PAWN_EXCLUDED.includes(v));
  const starts = (opts.startPool ?? BASIC).filter((v) => pool.includes(v));
  const baseSt = opts.weight != null ? WEIGHT_BASE_ST[opts.weight] : null;
  const reqVocs = normalizeRequire(opts.require, pool);
  // Pin all six stats to equality; this subsumes the user's bounds/match/bias/maximize.
  const bounds = {};
  for (const k of STATS) bounds[k] = { min: stats[k], max: stats[k] };

  const SOLVE_OPTS = { mip_rel_gap: 0, mip_abs_gap: 0 };
  const modelBase = { pool, bounds, baseSt, pawn: opts.pawn, match: [],
                      noPre10Switch: !!opts.noPre10Switch, reqVocs };

  for (const start of starts) {
    const nogoods = []; // allocations already seen for THIS start
    for (;;) {
      const lp = buildLP({ ...modelBase, start, objStat: null, nogoods });
      if (lp === null) break;
      const sol = highs.solve(lp, SOLVE_OPTS);
      if (sol.Status !== 'Optimal') break;
      const counts = decode(sol, pool);
      yield { start, counts, stats: statsOf(start, counts, baseSt) };
      nogoods.push(flatAlloc(counts));
    }
  }
}

/**
 * Eager wrapper over sameStatsBuilds: collect up to `cap` same-stats builds.
 * @returns {{builds: Array<{start,counts,stats}>, capped: boolean}}
 *   `capped` is true when more builds exist beyond the cap.
 */
export function enumerateSameStats(highs, opts = {}, stats, cap = 50) {
  const builds = [];
  let capped = false;
  for (const b of sameStatsBuilds(highs, opts, stats)) {
    if (builds.length >= cap) { capped = true; break; }
    builds.push(b);
  }
  return { builds, capped };
}
