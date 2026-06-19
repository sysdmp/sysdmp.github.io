// SPDX-License-Identifier: MIT
// Per-level stat-growth data for Dragon's Dogma™: Dark Arisen, ported verbatim
// from the Python prototype (ddda-build-solver.py). Values are the patched
// (non-vanilla) set — note marcher.to200 mattack=1/mdefense=2.
//
// A build is described by how many levels are spent in each (vocation, tier):
//   to10  : levels 1->10   (9 levels, basic vocations only)
//   to100 : levels 10->100 (90 levels, any vocation)
//   to200 : levels 100->200 (100 levels, any vocation)
// Final stats = the start vocation's `init` plus the summed per-level gains.

export const STATS = ['hp', 'st', 'attack', 'defense', 'mattack', 'mdefense'];

// Maximum reachable final value for each stat (Arisen, all vocations allowed),
// taken from the Python prototype's `--no-default --maximize <stat>`. Used to cap
// the UI inputs so the solver is never handed an impossible target. st is the
// largest across weight classes (5005 at LL, since weight only shifts stamina);
// the others are weight-independent.
export const STAT_MAX = {
  hp: 5820, st: 5005, attack: 956, defense: 767, mattack: 866, mdefense: 757,
};

// The four "combat" stats (attack/defense/mattack/mdefense). hp and st are the
// "vitals". Used for match-pairing rules: vitals pair only with each other,
// combat stats pair with any other combat stat.
export const COMBAT = ['attack', 'defense', 'mattack', 'mdefense'];
export const VITALS = ['hp', 'st'];

// Tolerance for an approximate ('~') match, by pair kind. The hp/st pair allows a
// wider gap (their raw values are large); combat pairs are tighter.
export const MATCH_TILDE_TOL = { vitals: 100, combat: 10 };

// Allowed match partners for each stat (per the pairing rules above).
export const MATCH_PARTNERS = Object.fromEntries(
  STATS.map((k) => [k, VITALS.includes(k) ? VITALS.filter((o) => o !== k)
                                          : COMBAT.filter((o) => o !== k)]),
);

export const basic = {
  fighter: {
    init:  { hp: 450, st: 540, attack: 80, defense: 80, mattack: 60, mdefense: 60 },
    to10:  { hp: 30, st: 20, attack: 4, defense: 3, mattack: 2, mdefense: 2 },
    to100: { hp: 37, st: 15, attack: 4, defense: 4, mattack: 2, mdefense: 1 },
    to200: { hp: 15, st: 5, attack: 1, defense: 3, mattack: 0, mdefense: 0 },
  },
  strider: {
    init:  { hp: 430, st: 540, attack: 70, defense: 70, mattack: 70, mdefense: 70 },
    to10:  { hp: 25, st: 25, attack: 3, defense: 3, mattack: 3, mdefense: 2 },
    to100: { hp: 25, st: 25, attack: 3, defense: 3, mattack: 3, mdefense: 2 },
    to200: { hp: 5, st: 15, attack: 1, defense: 1, mattack: 1, mdefense: 1 },
  },
  mage: {
    init:  { hp: 410, st: 540, attack: 60, defense: 60, mattack: 80, mdefense: 80 },
    to10:  { hp: 22, st: 20, attack: 2, defense: 3, mattack: 4, mdefense: 3 },
    to100: { hp: 21, st: 10, attack: 2, defense: 1, mattack: 4, mdefense: 4 },
    to200: { hp: 10, st: 10, attack: 0, defense: 0, mattack: 2, mdefense: 2 },
  },
};

export const adv = {
  warrior:  { to100: { hp: 40, st: 10, attack: 5, defense: 3, mattack: 2, mdefense: 1 },
              to200: { hp: 5, st: 15, attack: 2, defense: 2, mattack: 0, mdefense: 0 } },
  ranger:   { to100: { hp: 21, st: 30, attack: 4, defense: 2, mattack: 3, mdefense: 2 },
              to200: { hp: 5, st: 15, attack: 2, defense: 1, mattack: 0, mdefense: 1 } },
  sorcerer: { to100: { hp: 16, st: 15, attack: 2, defense: 1, mattack: 5, mdefense: 5 },
              to200: { hp: 10, st: 10, attack: 0, defense: 0, mattack: 3, mdefense: 1 } },
  mknight:  { to100: { hp: 30, st: 20, attack: 2, defense: 3, mattack: 3, mdefense: 3 },
              to200: { hp: 15, st: 5, attack: 1, defense: 1, mattack: 1, mdefense: 1 } },
  assassin: { to100: { hp: 22, st: 27, attack: 6, defense: 2, mattack: 2, mdefense: 1 },
              to200: { hp: 5, st: 15, attack: 3, defense: 1, mattack: 0, mdefense: 0 } },
  marcher:  { to100: { hp: 21, st: 20, attack: 2, defense: 3, mattack: 3, mdefense: 4 },
              to200: { hp: 10, st: 10, attack: 1, defense: 0, mattack: 1, mdefense: 2 } },
};

export const BASIC = Object.keys(basic);            // fighter, strider, mage
export const ALL = [...BASIC, ...Object.keys(adv)]; // + the six advanced

// Hybrid vocations (Mystic Knight, Assassin, Magick Archer) are Arisen-only —
// pawns cannot take them. (The UI also tags these as "hybrid".)
export const PAWN_EXCLUDED = ['mknight', 'assassin', 'marcher'];

// All vocations -> their growth data. Basic vocations carry an `init`; advanced
// ones only appear in to100/to200, so a missing tier means zero gains there.
export const VOCS = { ...basic, ...adv };

// Block sizes per tier (fixed by the game).
export const TIER_SIZE = { to10: 9, to100: 90, to200: 100 };

// Weight class -> base (level-1) stamina. The vocation `init` data above bakes in
// M (540); selecting another class overrides the starting stamina, shifting the
// final st by the same constant. Ordered light -> heavy. Other class effects
// (stamina-regen rate, max encumbrance) are informational and don't affect the
// solve, so they're not modeled here.
export const WEIGHT_CLASSES = ['SS', 'S', 'M', 'L', 'LL'];
export const WEIGHT_BASE_ST = { SS: 500, S: 520, M: 540, L: 560, LL: 580 };
export const DEFAULT_WEIGHT = 'M';

// Other per-class facts (informational — they do NOT affect the solve, only base
// stamina does). Ported from the prototype: body-weight range (kg) that puts a
// character in each class, stamina-recovery rate per second (with % relative to
// M), and base maximum encumbrance (kg the character can carry).
export const WEIGHT_RANGE = {
  SS: 'under 50kg', S: '50–69kg', M: '70–89kg', L: '90–109kg', LL: '110kg+',
};
export const WEIGHT_STAREGEN = {
  SS: { rate: 53, pct: '125%' }, S: { rate: 48, pct: '115%' },
  M: { rate: 42, pct: '100%' }, L: { rate: 38, pct: '90%' }, LL: { rate: 31, pct: '75%' },
};
export const WEIGHT_ENCUMBRANCE = { SS: 40, S: 50, M: 65, L: 75, LL: 100 };

// Per-level gain for (vocation, tier, stat); 0 when that vocation has no data
// for the tier (e.g. advanced vocations in to10, or a tier that omits a stat).
export function growth(voc, tier, stat) {
  const t = VOCS[voc]?.[tier];
  return t ? (t[stat] || 0) : 0;
}

// Balanced-objective weights: hp and st are discounted to 0.1 (vs 1.0 for the
// four combat stats). hp/st have large raw values and grow cheaply, so without
// this the max-total objective would pile level-ups into them at the expense of
// the combat stats. Mirrors the Python prototype's BALANCE_WEIGHTS.
export const BALANCE_WEIGHTS = {
  hp: 0.1, st: 0.1, attack: 1.0, defense: 1.0, mattack: 1.0, mdefense: 1.0,
};

// Largest per-level gain for each stat across all vocations/tiers. Used to
// normalize bias weights: stats grow at very different rates (hp ~40/lvl vs
// mdefense ~5/lvl), so dividing a stat's objective weight by its MAX_GAIN makes
// one unit of bias mean "the same amount of leveling invested" across stats.
export const MAX_GAIN = (() => {
  const m = {};
  for (const k of STATS) {
    let best = 0;
    for (const v of Object.keys(VOCS))
      for (const tier of ['to10', 'to100', 'to200'])
        best = Math.max(best, growth(v, tier, k));
    m[k] = best;
  }
  return m;
})();

// Final stats for a build: start vocation's init plus summed per-level gains.
// counts is { to10: {voc:n}, to100: {...}, to200: {...} }. `baseSt`, when given,
// overrides the level-1 stamina (weight class); otherwise the data default
// (M = 540) baked into the vocation init is used.
export function statsOf(start, counts, baseSt = null) {
  const s = { ...basic[start].init };
  if (baseSt != null) s.st = baseSt;
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const [voc, n] of Object.entries(counts[tier] || {})) {
      if (!n) continue;
      for (const k of STATS) s[k] += growth(voc, tier, k) * n;
    }
  }
  return s;
}

// Build a shareable link to the owoc.github.io planner for a solved build, so it
// can be fine-tuned there. The planner reads location.hash as a string of
// one-byte (2-hex-digit) fields:
//   [0]      'a' patched / 'v' vanilla — always 'a' (our growth data is patched)
//   [1]      start vocation: 'f' / 's' / 'm'
//   [2:20]   10->100 level counts, one byte per vocation in ALL order
//   [20:38]  100->200 level counts, same order
//   [38:44]  1->10 counts for the three basic vocations
// ALL matches the planner's `vocs` array, and we only ever level basics in 1->10
// (as the planner's pre-10 fields expect), so the mapping is lossless.
// `build` is { start, counts: { to10, to100, to200 } }.
export function owocUrl(build) {
  const hb = (n) => (n & 0xff).toString(16).padStart(2, '0');
  const { start, counts } = build;
  let s = 'a' + { fighter: 'f', strider: 's', mage: 'm' }[start];
  s += ALL.map((v) => hb(counts.to100[v] || 0)).join('');
  s += ALL.map((v) => hb(counts.to200[v] || 0)).join('');
  s += ['fighter', 'strider', 'mage'].map((v) => hb(counts.to10[v] || 0)).join('');
  return `https://owoc.github.io/#${s}`;
}

// Flavor quotes from Dragon's Dogma, shown (one at random) after each solve.
// Verbatim from the source list — `text` includes its surrounding quotation
// marks; `who` is the attribution as written. (Backtick strings so the embedded
// " and ' need no escaping.)
export const QUOTES = [
  { text: `"If you would face me...take up arms, newly Arisen!"`, who: `Grigori` },
  { text: `"If victory is elusive, seek new allies. Where that fails, seek new foes."`, who: `Pawn` },
  { text: `"Even in numbers, a weakling is a weakling still!"`, who: `Pawns about goblins` },
  { text: `"You shall not cast!"`, who: `a Pawn silencing an enemy` },
  { text: `"Are you come to lead the pawns on a quest to slay the Dragon? Those equivocal husks? Will or nil, the Arisen is always drawn to the Dragon, as puppets strung in Fate's own thread."`, who: `The Elysion, if met in Cassardis` },
  { text: `"Merciful winged death! All-powerful and merciless Grigori! Behold, you unrepentant blasphemers! THIS! Is absolute truth! THIS IS SALVATIO-"`, who: `The Elysion prior to being crushed by Grigori` },
  { text: `"The rantings of an upjumped zealot make for tedious listening."`, who: `Grigori, after crushing the aforementioned zealot` },
  { text: `"But heed the zealot's lesson well! When the weak court death, they find it."`, who: `Grigori` },
  { text: `"Just so. One step forward after the next, come what may. That is what it means to live."`, who: `The Seneschal` },
  { text: `"Him who knows that I know what he seeks to know, knows it well, while he who knows not, knows not what I know or know not."`, who: `The Fool` },
  { text: `"What a base and trifling creature is man. Yet at once he is the master of this empyreal flow, grand as all the heavens."`, who: `Daimon` },
  { text: `"They're masterworks all, you can't go wrong."`, who: `Caxton` },
  { text: `"Wolves hunt in packs."`, who: `Pawn` },
  { text: `"It bears the head of a cock!"`, who: `Pawn` },
  { text: `"Should we jump, Arisen? It may shorten our path.. or our lives."`, who: `Pawn` },
  { text: `"Human bones that move on their own!"`, who: `Pawn` },
  { text: `"I love Grigori. He really stole my heart."`, who: `Some Reddit user` },
  { text: `"IT'S A HUMAN!!\nBLOODY HUMAN!!\nSTUPID HUMAN!!"`, who: `Goblin` },
];
