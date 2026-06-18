// Per-level stat-growth data for Dragon's Dogma: Dark Arisen, ported verbatim
// from the Python prototype (ddda-build-solver.py). Values are the patched
// (non-vanilla) set — note marcher.to200 mattack=1/mdefense=2.
//
// A build is described by how many levels are spent in each (vocation, tier):
//   to10  : levels 1->10   (9 levels, basic vocations only)
//   to100 : levels 10->100 (90 levels, any vocation)
//   to200 : levels 100->200 (100 levels, any vocation)
// Final stats = the start vocation's `init` plus the summed per-level gains.

export const STATS = ['hp', 'st', 'attack', 'defense', 'mattack', 'mdefense'];

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

// All vocations -> their growth data. Basic vocations carry an `init`; advanced
// ones only appear in to100/to200, so a missing tier means zero gains there.
export const VOCS = { ...basic, ...adv };

// Block sizes per tier (fixed by the game).
export const TIER_SIZE = { to10: 9, to100: 90, to200: 100 };

// Per-level gain for (vocation, tier, stat); 0 when that vocation has no data
// for the tier (e.g. advanced vocations in to10, or a tier that omits a stat).
export function growth(voc, tier, stat) {
  const t = VOCS[voc]?.[tier];
  return t ? (t[stat] || 0) : 0;
}

// Final stats for a build: start vocation's init plus summed per-level gains.
// counts is { to10: {voc:n}, to100: {...}, to200: {...} }.
export function statsOf(start, counts) {
  const s = { ...basic[start].init };
  for (const tier of ['to10', 'to100', 'to200']) {
    for (const [voc, n] of Object.entries(counts[tier] || {})) {
      if (!n) continue;
      for (const k of STATS) s[k] += growth(voc, tier, k) * n;
    }
  }
  return s;
}
