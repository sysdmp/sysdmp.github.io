#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 sysdmp
"""ddda-build-solver: Dragon's Dogma™: Dark Arisen level-200 build solver.

Finds character builds that meet target stat requirements (HP, stamina, attack,
defense, magick attack, magick defense) at level 200, given the game's
vocation-based stat-growth rules.

Leveling model
--------------
A character starts in a basic vocation (fighter / strider / mage) and gains
stats per level according to the vocation active at that level. Growth is split
into three ranges with different per-level gains:

    1 -> 10    (9 levels)   basic vocations only      ("to10" tier)
    10 -> 100  (90 levels)  any of the 9 vocations     ("to100" tier)
    100 -> 200 (100 levels) any of the 9 vocations     ("to200" tier)

Because growth is linear, a build is fully described by how many levels are
spent in each (vocation, tier) plus the starting vocation. Final stats are the
starting base plus the summed per-level gains.

Solvers
-------
- ILP (default, requires PuLP): models the build as an integer linear program
  and finds exact, provably feasible (or provably infeasible) solutions.
- search (fallback): stochastic hill-climbing with random restarts, used when
  PuLP is unavailable or ``--solver search`` is given.

Run ``ddda-build-solver.py --help`` for the full set of options.
"""

import random, argparse, json, sys, os, time, shlex

try:
    import pulp
    HAVE_PULP = True
except ImportError:
    HAVE_PULP = False

# --- terminal styling -------------------------------------------------------
# Colors are enabled only on a real TTY (and when not disabled / NO_COLOR set),
# so piping or redirecting output stays clean plain text.
_COLOR = sys.stdout.isatty() and os.environ.get('NO_COLOR') is None

def _set_color(enabled):
    """Force color output on or off, overriding TTY auto-detection."""
    global _COLOR
    _COLOR = enabled

# Box-drawing glyphs. The unicode set draws clean tables in any UTF-8 terminal;
# the ascii set is a 7-bit fallback for legacy terminals / ascii-only pipelines.
# Keys: tl tr bl br (corners), h v (lines), tm bm lm rm cross (junctions),
# plus heavy separator and inline symbols used outside tables.
_CHARSETS = {
    'unicode': dict(tl='┌', tr='┐', bl='└', br='┘', h='─', v='│',
                    tm='┬', bm='┴', lm='├', rm='┤', cross='┼',
                    heavy='━', mul='×', ok='✓', bad='✗', ge='≥', le='≤',
                    arrow='→', dash='—'),
    'ascii':   dict(tl='+', tr='+', bl='+', br='+', h='-', v='|',
                    tm='+', bm='+', lm='+', rm='+', cross='+',
                    heavy='=', mul='x', ok='[OK]', bad='[X]', ge='>=', le='<=',
                    arrow='->', dash='-'),
}
# Default to unicode unless the locale clearly isn't UTF-8.
_use_ascii_default = 'utf' not in (os.environ.get('LANG', '') + os.environ.get('LC_ALL', '')).lower()
GLYPH = _CHARSETS['ascii'] if _use_ascii_default else _CHARSETS['unicode']

def _set_charset(name):
    """Force the box-drawing glyph set ('unicode' or 'ascii')."""
    global GLYPH
    GLYPH = _CHARSETS[name]

_ANSI = {
    'reset': '\033[0m', 'bold': '\033[1m', 'dim': '\033[2m',
    'red': '\033[31m', 'green': '\033[32m', 'yellow': '\033[33m',
    'blue': '\033[34m', 'magenta': '\033[35m', 'cyan': '\033[36m', 'white': '\033[37m',
}

def c(text, *styles):
    """Wrap ``text`` in ANSI codes for the given styles (e.g. 'bold', 'green').

    Returns the text unchanged when color is disabled or no styles are given,
    so call sites can wrap unconditionally. Unknown style names are ignored.
    """
    if not _COLOR or not styles:
        return str(text)
    pre = ''.join(_ANSI[s] for s in styles if s in _ANSI)
    return f"{pre}{text}{_ANSI['reset']}" if pre else str(text)

def _vlen(s):
    """Return the visible length of ``s``, ignoring ANSI escape sequences.

    Used for column-width math so that colored cells align the same as plain
    ones (the escape codes occupy no screen columns).
    """
    out, i = 0, 0
    while i < len(s):
        if s[i] == '\033':
            j = s.find('m', i)
            if j != -1:
                i = j + 1
                continue
        out += 1
        i += 1
    return out

def _pad(s, width, align='left'):
    """Pad ``s`` with spaces to ``width`` visible columns ('left'/'right'/'center')."""
    gap = max(0, width - _vlen(s))
    if align == 'right':
        return ' ' * gap + s
    if align == 'center':
        l = gap // 2
        return ' ' * l + s + ' ' * (gap - l)
    return s + ' ' * gap

def render_table(headers, rows, aligns=None, title=None):
    """Render a box-drawing table as a string and return it.

    Args:
        headers: list of column header strings (may already contain ANSI codes).
        rows: list of rows, each a list of cell strings (one per column).
        aligns: optional per-column alignment, 'left'/'right'/'center';
            defaults to all-left.
        title: optional caption centered above the table.

    Column widths are computed from visible (ANSI-stripped) cell lengths, and
    the active GLYPH set determines whether borders are Unicode or ASCII.
    """
    ncol = len(headers)
    aligns = aligns or ['left'] * ncol
    widths = [_vlen(headers[i]) for i in range(ncol)]
    for row in rows:
        for i in range(ncol):
            widths[i] = max(widths[i], _vlen(row[i]))

    def line(l, m, r):
        """Build a horizontal rule with the given left/middle/right junctions."""
        return l + m.join(GLYPH['h'] * (w + 2) for w in widths) + r
    def fmt(cells):
        """Format one row of cells between vertical borders."""
        v = GLYPH['v']
        return f'{v} ' + f' {v} '.join(_pad(cells[i], widths[i], aligns[i]) for i in range(ncol)) + f' {v}'

    out = []
    if title:
        total = sum(w + 3 for w in widths) + 1
        out.append(c(_pad(title, total - 2, 'center'), 'bold', 'cyan'))
    out.append(line(GLYPH['tl'], GLYPH['tm'], GLYPH['tr']))
    out.append(fmt([c(h, 'bold') for h in headers]))
    out.append(line(GLYPH['lm'], GLYPH['cross'], GLYPH['rm']))
    for row in rows:
        out.append(fmt(row))
    out.append(line(GLYPH['bl'], GLYPH['bm'], GLYPH['br']))
    return '\n'.join(out)

# --- per-level stat-growth data, by vocation and tier ---
basic = {
  'fighter': dict(init=dict(hp=450,st=540,attack=80,defense=80,mattack=60,mdefense=60),
                  to10=dict(hp=30,st=20,attack=4,defense=3,mattack=2,mdefense=2),
                  to100=dict(hp=37,st=15,attack=4,defense=4,mattack=2,mdefense=1),
                  to200=dict(hp=15,st=5,attack=1,defense=3,mattack=0,mdefense=0)),
  'strider': dict(init=dict(hp=430,st=540,attack=70,defense=70,mattack=70,mdefense=70),
                  to10=dict(hp=25,st=25,attack=3,defense=3,mattack=3,mdefense=2),
                  to100=dict(hp=25,st=25,attack=3,defense=3,mattack=3,mdefense=2),
                  to200=dict(hp=5,st=15,attack=1,defense=1,mattack=1,mdefense=1)),
  'mage':    dict(init=dict(hp=410,st=540,attack=60,defense=60,mattack=80,mdefense=80),
                  to10=dict(hp=22,st=20,attack=2,defense=3,mattack=4,mdefense=3),
                  to100=dict(hp=21,st=10,attack=2,defense=1,mattack=4,mdefense=4),
                  to200=dict(hp=10,st=10,attack=0,defense=0,mattack=2,mdefense=2)),
}
adv = {
  'warrior':  dict(to100=dict(hp=40,st=10,attack=5,defense=3,mattack=2,mdefense=1),
                   to200=dict(hp=5,st=15,attack=2,defense=2,mattack=0,mdefense=0)),
  'ranger':   dict(to100=dict(hp=21,st=30,attack=4,defense=2,mattack=3,mdefense=2),
                   to200=dict(hp=5,st=15,attack=2,defense=1,mattack=0,mdefense=1)),
  'sorcerer': dict(to100=dict(hp=16,st=15,attack=2,defense=1,mattack=5,mdefense=5),
                   to200=dict(hp=10,st=10,attack=0,defense=0,mattack=3,mdefense=1)),
  'mknight':  dict(to100=dict(hp=30,st=20,attack=2,defense=3,mattack=3,mdefense=3),
                   to200=dict(hp=15,st=5,attack=1,defense=1,mattack=1,mdefense=1)),
  'assassin': dict(to100=dict(hp=22,st=27,attack=6,defense=2,mattack=2,mdefense=1),
                   to200=dict(hp=5,st=15,attack=3,defense=1,mattack=0,mdefense=0)),
  'marcher':  dict(to100=dict(hp=21,st=20,attack=2,defense=3,mattack=3,mdefense=4),
                   to200=dict(hp=10,st=10,attack=1,defense=0,mattack=1,mdefense=2)),  # patched (non-vanilla)
}

STATS = ['hp','st','attack','defense','mattack','mdefense']
# Alternative (British) spellings accepted wherever a stat name is given, on the
# command line and inside comma-separated stat lists. Maps alias -> canonical.
STAT_ALIASES = {'defence': 'defense', 'mdefence': 'mdefense'}
BASIC = list(basic.keys())
ALL = list(basic.keys()) + list(adv.keys())
VOCS = {**basic, **adv}   # all vocations -> their growth data, for growth()
# Largest per-level gain for each stat across all vocations/tiers. Used to
# normalize --bias boosts: stats grow at very different rates (hp ~40/lvl vs
# mdefense ~5/lvl), so an un-normalized weight boost would favor fast-growing
# stats. Dividing a boost by MAX_GAIN makes a unit of boost mean "the same
# amount of leveling invested," so --bias priority follows the listed order.
MAX_GAIN = {k: max(d[t][k] for d in VOCS.values()
                            for t in ('to10', 'to100', 'to200') if t in d)
            for k in STATS}
# Advanced vocations disabled by --pawn (vocations a pawn cannot take).
PAWN_EXCLUDED = ['mknight', 'marcher', 'assassin']
# --divisor rounds a stat to a multiple of the given integer (e.g. 100 -> a
# "perfect" multiple of 100, 50 -> half-perfect, 10 -> a round decimal). Handled
# as {stat: divisor} in the solver.
# --match tolerance for the approximate '~' operator: paired stats may differ by
# at most this many points (the exact '=' operator forces an equal value, tol 0).
# The hp/st (vitals) pair allows a wider gap, since those stats have large raw
# values; combat pairs are tighter.
MATCH_TILDE_TOLERANCE = 10
MATCH_TILDE_TOLERANCE_VITALS = 100
# Per-stat weight used by the balanced (default) objective's total-stat sum.
# hp/st have much larger raw magnitudes than the combat stats and grow more
# cheaply, so weighting them below 1 keeps the balanced build from dumping all
# its level-ups into hp/st at the expense of attack/defense/mattack/mdefense.
BALANCE_WEIGHTS = {
    'hp':       0.1,
    'st':       0.1,
    'attack':   1.0,
    'defense':  1.0,
    'mattack':  1.0,
    'mdefense': 1.0,
}
# --bias adds extra weight to a stat in the objective's total. The i-th listed
# stat (0-based) gets BIAS_BOOST_BASE * BIAS_BOOST_FALLOFF**i, normalized by the
# stat's MAX_GAIN, added to its weight -- so earlier stats are favored more than
# later ones and the priority order doesn't get distorted by growth rates.
BIAS_BOOST_BASE = 10.0
BIAS_BOOST_FALLOFF = 0.5

# Integer scale for the objective. The balanced weights (0.1 / 1.0) and the bias
# adjustment (+/- BIAS_BOOST_BASE * FALLOFF**i / MAX_GAIN[k], i in 0..4) are
# fractional; multiplying by 960 clears every denominator exactly (0.5^4 = 1/16,
# MAX_GAIN in {40,30,6,4,5,5}, balance /10 -- 960 is minimal). Integer objective
# coefficients make CBC (here) and HiGHS (the web app) agree on the optimum to the
# unit, so the only cross-engine differences are genuine ties, which TIEBREAK_ORDER
# then resolves identically. KEEP IN SYNC with src/data.js (OBJ_SCALE).
OBJ_SCALE = 960

# Canonical tie-break order (combat-first): when several builds tie at the optimal
# objective, both solvers lexicographically maximize these stats in turn -- pinning
# each -- to collapse the degenerate optima to ONE stat-vector. Purely a chooser
# among equal-score builds; never changes the score or which constraints are met.
# KEEP IN SYNC with src/data.js (TIEBREAK_ORDER).
TIEBREAK_ORDER = ['attack', 'defense', 'mattack', 'mdefense', 'hp', 'st']

def bias_ranks(bias_tiers):
    """Map each biased stat to (sign, group_index) from a list of (sign, [stats]).

    Positive and negative tiers are indexed independently (group_index is the
    0-based position within that sign's tiers), so the bias magnitude and the
    displayed tier number are consistent everywhere they're computed.
    """
    ranks, pos_i, neg_i = {}, 0, 0
    for sign, tier in bias_tiers:
        idx = pos_i if sign > 0 else neg_i
        for stat in tier:
            ranks[stat] = (sign, idx)
        if sign > 0: pos_i += 1
        else: neg_i += 1
    return ranks

# Character weight class sets base stamina. The data above assumes M (540).
WEIGHTS = {'SS': 500, 'S': 520, 'M': 540, 'L': 560, 'LL': 580}
# Body-weight range that determines each class (kg).
WEIGHT_RANGES = {
    'SS': 'under 50',
    'S':  '50-69',
    'M':  '70-89',
    'L':  '90-109',
    'LL': '110 and over',
}
# Stamina recovery rate per second, with multiplier relative to M (100%).
WEIGHT_STAREGEN = {
    'SS': (53, '125%'),
    'S':  (48, '115%'),
    'M':  (42, '100%'),
    'L':  (38, '90%'),
    'LL': (31, '75%'),
}
# Base maximum encumbrance (kg a character can carry) per weight class.
WEIGHT_ENCUMBRANCE = {'SS': 40, 'S': 50, 'M': 65, 'L': 75, 'LL': 100}

def growth(voc, tier):
    """Return the per-level stat-gain dict for a vocation in a given tier.

    ``tier`` is one of 'to10', 'to100', 'to200'. Works for both basic and
    advanced vocations (advanced ones only define 'to100'/'to200').
    """
    return VOCS[voc][tier]

def stats_of(start, c10, c100, c200, base_st=None):
    """Compute final stats for a build.

    Args:
        start: starting basic vocation, providing the level-1 base stats.
        c10: dict {vocation: level-count} for the 1->10 range (sums to 9).
        c100: dict {vocation: level-count} for the 10->100 range (sums to 90).
        c200: dict {vocation: level-count} for the 100->200 range (sums to 100).
        base_st: optional override for starting stamina (weight class); when
            None the data default (M = 540) baked into ``start`` is used.

    Returns:
        dict mapping each stat in STATS to its final value.
    """
    s = dict(basic[start]['init'])
    if base_st is not None:
        s['st'] = base_st   # weight class overrides the data's default (M=540)
    for counts, tier in ((c10, 'to10'), (c100, 'to100'), (c200, 'to200')):
        for voc, n in counts.items():
            g = growth(voc, tier)
            for k in STATS: s[k] += g[k] * n
    return s

def penalty(s, cons):
    """Score how far stats ``s`` fall outside the target constraints.

    Args:
        s: final-stats dict (as from ``stats_of``).
        cons: dict {stat: (min_or_None, max_or_None)}.

    Returns:
        Float penalty: the total distance outside any bound, weighted x5 so a
        single violation outweighs nondescript differences. 0.0 means every
        constraint is satisfied (the build is feasible).
    """
    p = 0.0
    for k in STATS:
        lo, hi = cons[k]
        if lo is not None and s[k] < lo: p += (lo - s[k]) * 5
        if hi is not None and s[k] > hi: p += (s[k] - hi) * 5
    return p

def rand_counts(vocs, total):
    """Randomly distribute ``total`` level-ups among ``vocs``.

    Returns a dict {vocation: count} whose counts sum to ``total`` (used to seed
    a random starting point for the search solver).
    """
    c = {v:0 for v in vocs}
    for _ in range(total):
        c[random.choice(vocs)] += 1
    return c

def neighbors_move(c, vocs):
    """Return a neighbor of distribution ``c`` with one level moved between vocations.

    Picks a source vocation with a positive count and a random destination, then
    shifts a single level from source to destination. Returns None if the random
    source and destination coincide (caller skips and retries).
    """
    a = random.choice([v for v in vocs if c[v]>0])
    b = random.choice(vocs)
    if a==b: return None
    nc = dict(c); nc[a]-=1; nc[b]+=1
    return nc

SEARCH_RESTARTS = 60   # random restarts per search() call; iters split across them

class SearchInterrupted(Exception):
    """Raised when the search solver is Ctrl+C'd; carries the best build so far
    (a build tuple, or None if nothing was evaluated yet)."""
    def __init__(self, best):
        super().__init__("search interrupted")
        self.best = best

def search(cons, iters=1500000, base_st=None, allowed=None, start_pool=None, progress=None,
           pawn=False, no_early_switch=False):
    """Stochastic hill-climb for a feasible build (fallback when PuLP is absent).

    Performs random restarts, each starting from a random vocation distribution
    and repeatedly accepting single-level moves (and occasional start-vocation
    swaps) that do not worsen the penalty.

    Args:
        cons: dict {stat: (min, max)} target constraints.
        iters: total moves to attempt, split evenly across restarts.
        base_st: optional starting-stamina override (weight class).
        allowed: optional iterable restricting which vocations may be used in
            any range (defaults to all).
        start_pool: optional iterable of allowed basic start vocations (defaults
            to the basics still in `allowed`).
        progress: optional callback invoked with the number of restarts finished
            (1..SEARCH_RESTARTS) after each restart, for progress reporting.
        pawn: when True, enforce the pawn rule that at least one 1->10 level is in
            the starting vocation (see solve_ilp); the start always keeps >=1.
        no_early_switch: when True, forbid pre-10 vocation switching entirely --
            all nine 1->10 levels stay in the start vocation.

    Returns:
        The best build found as a tuple
        (penalty, start, c10, c100, c200, stats). penalty 0 means feasible;
        a positive value means this is only the closest build found.
    """
    adv_pool = list(allowed) if allowed is not None else ALL
    basic_pool = [v for v in BASIC if v in adv_pool]
    starts = list(start_pool) if start_pool is not None else basic_pool
    best = None

    def consider(cand):
        nonlocal best
        if best is None or cand[0] < best[0]:
            best = cand

    for restart in range(SEARCH_RESTARTS):
        start = random.choice(starts)
        # Seed the 1->10 distribution. no_early_switch pins all 9 to the start;
        # pawn keeps >=1 in the start (1 + scatter 8); otherwise scatter all 9.
        if no_early_switch:
            c10 = {v: 0 for v in basic_pool}; c10[start] = 9
        elif pawn:
            c10 = rand_counts(basic_pool, 8)
            c10[start] += 1
        else:
            c10 = rand_counts(basic_pool, 9)
        c100 = rand_counts(adv_pool, 90)
        c200 = rand_counts(adv_pool, 100)
        cur_p = penalty(stats_of(start,c10,c100,c200,base_st), cons)
        try:
            for it in range(iters // SEARCH_RESTARTS):
                which = random.random()
                if which < 0.1:
                    nstart = random.choice(starts); nc10,nc100,nc200=c10,c100,c200
                    if no_early_switch and nstart != start:
                        # all 9 pre-10 levels follow the start vocation
                        nc10 = {v: 0 for v in basic_pool}; nc10[nstart] = 9
                    elif pawn and nstart != start and c10[nstart] == 0:
                        # the new start needs a 1->10 level; move one into it from
                        # a basic that has a surplus (prefer the old start).
                        donors = [v for v in basic_pool if c10[v] > (1 if v == start else 0)]
                        if not donors: continue
                        nc10 = dict(c10); nc10[max(donors, key=lambda v: c10[v])] -= 1; nc10[nstart] += 1
                    np_ = penalty(stats_of(nstart,nc10,nc100,nc200,base_st), cons)
                    if np_<=cur_p:
                        start=nstart; c10=nc10; cur_p=np_
                    continue
                elif which < 0.2:
                    if no_early_switch: continue   # 1->10 is fixed to the start vocation
                    m = neighbors_move(c10, basic_pool);
                    if m is None: continue
                    if pawn and m[start] < 1: continue   # don't drain the start vocation
                    nc10,nc100,nc200=m,c100,c200; nstart=start
                elif which < 0.6:
                    m = neighbors_move(c100, adv_pool)
                    if m is None: continue
                    nc10,nc100,nc200=c10,m,c200; nstart=start
                else:
                    m = neighbors_move(c200, adv_pool)
                    if m is None: continue
                    nc10,nc100,nc200=c10,c100,m; nstart=start
                np_ = penalty(stats_of(nstart,nc10,nc100,nc200,base_st), cons)
                if np_<=cur_p:
                    c10,c100,c200=nc10,nc100,nc200; cur_p=np_
        except KeyboardInterrupt:
            # fold this restart's in-progress state in, then signal upward
            consider((cur_p, start, c10, c100, c200, stats_of(start,c10,c100,c200,base_st)))
            raise SearchInterrupted(best)
        consider((cur_p, start, c10, c100, c200, stats_of(start,c10,c100,c200,base_st)))
        if progress is not None:
            progress(restart + 1)
    return best

def solve_ilp(cons, count=1, rounding=None, match=(),
              base_st=None, allowed=None,
              maximize=(), bias_tiers=(), start_pool=None,
              verbose=False, time_limit=5, pawn=False, no_early_switch=False,
              require=None):
    """Exact integer-linear solver. Returns a list of distinct feasible builds,
    each a tuple (penalty, start, c10, c100, c200, stats); penalty is always 0
    (constraints are modeled as hard). Returns [] if infeasible.

    Two phases (mirrors the web solveMaxTotal -> sameStatsBuilds):
      1. Find the single optimal build via the full objective pipeline (maximize
         lex pre-pass -> bounds/divisor/match targets -> bias equal-share floor ->
         balanced total), taking the best start vocation. This fixes the optimal
         final stats.
      2. Pin all six stats to that optimum and enumerate up to `count` DISTINCT
         (vocation, tier) allocations reaching those exact stats -- across all
         starts, walked with no-good cuts. So `count > 1` surfaces alternate
         leveling paths to the SAME stats, never builds with worse stats; with the
         default count=1 only the optimum is returned. Fewer than `count` builds
         come back when the same-stats set is smaller than asked.

    `rounding` maps a stat name to an integer divisor (e.g. 100, 50, 10). The
    stat's value is forced to divisor*k via a fresh integer k, its max bound is
    dropped, and its min (if any) is kept as a floor.

    `match` is an iterable of (stat_a, stat_b, tol) triples constraining the two
    final values: tol 0 forces them equal, tol>0 lets them differ by at most
    `tol` points (|stat_a - stat_b| <= tol). Each stat's own min/max still apply.

    `allowed`: optional iterable restricting which vocations may be used in any
    range (defaults to all); the 1->10 range uses the basics within it.
    `start_pool`: optional iterable of allowed basic start vocations (defaults
    to all basics).

    `pawn`: when True, model the pawn rule that the character must spend at least
    one of its 1->10 levels in its starting vocation (a pawn cannot switch
    vocation at level 1; the forced first level-up is in the start vocation), so
    x10[start] >= 1. The Arisen (default) has no such restriction.

    `maximize`: an ordered sequence of stat names to maximize, highest priority
    first, via sequential lexicographic optimization: the first stat is
    maximized, frozen at its optimum, then the next, and so on. This is a hard
    ordering that sits above the weighted total-stat objective.

    `bias_tiers`: an ordered list of (sign, [stat names]) tiers. sign=+1 favors,
    -1 reduces. Within each sign group the i-th tier gets magnitude
    BIAS_BOOST_BASE * FALLOFF**i applied equally to every stat in it (stats
    sharing a tier are weighted the same; earlier tiers stronger). Positive tiers
    also get an equal-share growth floor; negative tiers only lower the weight. A
    soft preference traded off against the other stats, not a hard ordering.

    `verbose`: when True, run CBC with msg=True so it prints its own solver log.

    `time_limit`: per-CBC-solve cap in seconds (always 5 in practice; None would
    disable it and let CBC grind to a proven optimum, however long that takes).
    """
    # Time-cap each CBC solve. Some flag combinations (e.g. --divisor 100 with a
    # continuous --bias t) leave CBC with the optimum already in hand but unable
    # to *prove* it for a long time; with a limit it returns the best incumbent,
    # which is fine here (we round/pin values anyway, and want a build, not a
    # certificate). Solves that hit the limit are still feasible builds.
    cbc_kw = {'msg': verbose}
    if time_limit is not None:
        cbc_kw['timeLimit'] = time_limit
    cbc = pulp.PULP_CBC_CMD(**cbc_kw)   # reused for every solve
    # A solve is usable if CBC proved optimality OR hit the time limit with a
    # feasible incumbent (status "Not Solved" but variables have values). Only a
    # genuinely infeasible/unbounded result has no usable values.
    def solved_ok(prob):
        status = pulp.LpStatus[prob.status]
        if status == "Optimal":
            return True
        if status == "Infeasible" or status == "Unbounded":
            return False
        # timed out: usable iff it produced variable values
        return any(v.value() is not None for v in prob.variables())
    rounding = dict(rounding or {})
    adv_pool = list(allowed) if allowed is not None else ALL
    starts = list(start_pool) if start_pool is not None else BASIC
    # basic vocations usable in the 1->10 range: those in the (avoid-filtered) pool
    basic_pool = [v for v in BASIC if v in adv_pool]
    # Required vocations, per tier { 'to10'|'to100'|'to200': {voc: min levels} }; keep
    # only vocations usable in that tier (1->10 is basics only; a require not in the
    # pool would bound a nonexistent var). Each min clamped to 1..tier-size.
    TIER_SZ = {'to10': 9, 'to100': 90, 'to200': 100}
    require = require or {}
    req_tiers = {}
    for tier, sz in TIER_SZ.items():
        usable = set(basic_pool if tier == 'to10' else adv_pool)
        req_tiers[tier] = {v: max(1, min(sz, int(n)))
                           for v, n in (require.get(tier) or {}).items() if v in usable}
    # penalty is reported against constraints as actually enforced: rounding stats
    # keep only their floor, so their dropped max isn't counted. (start-independent.)
    eval_cons = {k: ((cons[k][0], None) if k in rounding else cons[k]) for k in STATS}

    # Per-stat objective weights: the base balance weights plus any --bias adjustment.
    # Within each sign group (positive favor / negative reduce), the i-th tier gets
    # magnitude BIAS_BOOST_BASE * FALLOFF**i, applied with the tier's sign and divided
    # by the stat's MAX_GAIN so the adjustment rewards/penalizes "leveling invested"
    # rather than raw points. The two groups are indexed independently. The equal-share
    # floor (phase 1) guarantees positively-biased stats grow (weighted sum is
    # winner-take-all). (start-independent.)
    # Scaled to INTEGER by OBJ_SCALE so CBC and the web's HiGHS compute identical
    # objective values (matches effWeights in src/solver.js).
    eff_weights = {k: round(OBJ_SCALE * BALANCE_WEIGHTS[k]) for k in STATS}
    for stat, (sign, idx) in bias_ranks(bias_tiers).items():
        eff_weights[stat] += round(sign * OBJ_SCALE * BIAS_BOOST_BASE * (BIAS_BOOST_FALLOFF ** idx) / MAX_GAIN[stat])

    # The start vocation only shifts the constant base stats, so we build one ILP
    # family per allowed basic start. structural_model() emits the part shared by both
    # phases below: the per-(vocation,tier) integer level vars, the block-size sums, the
    # pawn / no-switcheroo / require constraints, and each stat's value expression.
    def structural_model(start):
        base = dict(basic[start]['init'])
        if base_st is not None:
            base['st'] = base_st   # weight class overrides the data's default (M=540)
        prob = pulp.LpProblem("build", pulp.LpMinimize)
        # integer count of level-ups taken in each (vocation, tier), with upper
        # bounds = the block size (used as big-M for the no-good cuts below).
        x10  = {v: pulp.LpVariable(f"x10_{v}",  lowBound=0, upBound=9,   cat="Integer") for v in basic_pool}
        x100 = {v: pulp.LpVariable(f"x100_{v}", lowBound=0, upBound=90,  cat="Integer") for v in adv_pool}
        x200 = {v: pulp.LpVariable(f"x200_{v}", lowBound=0, upBound=100, cat="Integer") for v in adv_pool}
        # (var dict, vocations, block size) per range; reused for block-size
        # constraints and no-good cuts.
        tiers = [(x10, basic_pool, 9), (x100, adv_pool, 90), (x200, adv_pool, 100)]

        # block sizes: 1->10 = 9 levels, 10->100 = 90, 100->200 = 100
        for xs, _, total in tiers:
            prob += pulp.lpSum(xs.values()) == total

        # Pawn rule: a pawn cannot change vocation at level 1, so its forced first
        # level-up is taken in the starting vocation. At least one 1->10 level must
        # therefore go to `start` (leaving up to 8 for a basic-vocation switch).
        if pawn:
            prob += x10[start] >= 1
        # No early switcheroo: forbid changing vocation before level 10 entirely --
        # all nine 1->10 levels stay in the start vocation. (Subsumes the pawn >=1.)
        if no_early_switch:
            prob += x10[start] == 9

        # Required vocations: per tier, each listed vocation takes >= its minimum.
        # A per-tier sum of minimums > the tier size is infeasible via the block-size
        # constraint above (validated up front in main for a clear message).
        for xs, tier in ((x10, 'to10'), (x100, 'to100'), (x200, 'to200')):
            for v, n in req_tiers[tier].items():
                prob += xs[v] >= n

        # each stat's final value as a linear expression
        exprs = {}
        for k in STATS:
            exprs[k] = base[k] \
                + pulp.lpSum(growth(v,'to10')[k]  * x10[v]  for v in basic_pool) \
                + pulp.lpSum(growth(v,'to100')[k] * x100[v] for v in adv_pool) \
                + pulp.lpSum(growth(v,'to200')[k] * x200[v] for v in adv_pool)
        return prob, x10, x100, x200, tiers, exprs

    def read_counts(x10, x100, x200):
        c10  = {v: int(round(x10[v].value()))  for v in basic_pool}
        c100 = {v: int(round(x100[v].value())) for v in adv_pool}
        c200 = {v: int(round(x200[v].value())) for v in adv_pool}
        return c10, c100, c200

    # ---- Phase 1: find the single optimal build's final stats. -----------------
    # For each allowed start, run the full objective pipeline (maximize lex pre-pass
    # -> bounds/divisor/match targets -> bias equal-share floor -> balanced total)
    # and take that start's optimum; the best across starts (by the same lexicographic
    # quality the solver optimizes) gives the target stats. Mirrors web solveMaxTotal.
    best = None   # (quality_key, stats) of the global optimum
    for start in starts:
        prob, x10, x100, x200, tiers, exprs = structural_model(start)

        # --maximize lexicographic pre-pass: maximize each listed stat in priority
        # order, freezing each at its optimum before moving on. Skipped when empty.
        # Runs BEFORE the targets below: each stat is optimized over the structural
        # build space only, so bounds/divisor/match cannot lower the peak. The optima
        # are pinned, then the targets apply -- a target that can't be met at the peak
        # makes the start infeasible.
        infeasible_start = False
        lex_opts = []   # the pinned maximized optima, in priority order
        for stat in maximize:
            prob.setObjective(-exprs[stat])  # minimize -expr == maximize expr
            prob.solve(cbc)
            if not solved_ok(prob):
                infeasible_start = True
                break
            opt = round(exprs[stat].value())
            lex_opts.append(opt)
            prob += exprs[stat] >= opt   # pin maximized optimum
        if infeasible_start:
            continue  # this start vocation cannot satisfy the constraints

        # Impose the per-stat bounds / divisor / match targets, ranked below the
        # pinned maximize optima.
        for k in STATS:
            lo, hi = cons[k]
            if k in rounding:
                # divisor mode: value == divisor*mult, min kept as floor, max dropped
                mult = pulp.LpVariable(f"round_{k}_{start}", lowBound=0, cat="Integer")
                prob += exprs[k] == rounding[k] * mult
                if lo is not None: prob += exprs[k] >= lo
            else:
                if lo is not None: prob += exprs[k] >= lo
                if hi is not None: prob += exprs[k] <= hi
        # match mode: tol 0 forces paired stats to share a value; tol>0 (the '~'
        # operator) lets them differ by at most `tol` points (|a - b| <= tol).
        for a_stat, b_stat, tol in match:
            if tol == 0:
                prob += exprs[a_stat] == exprs[b_stat]
            else:
                prob += exprs[a_stat] - exprs[b_stat] <= tol
                prob += exprs[b_stat] - exprs[a_stat] <= tol

        # --bias "equal-share floor then maximize": a single weighted-sum objective is
        # winner-take-all per range (e.g. assassin dominates attack and gives 0
        # mdefense, so a lower-priority biased stat never moves). To guarantee every
        # POSITIVELY-biased stat grows -- earlier tiers more -- first maximize a shared
        # t under value(stat) >= share_i * t * MAX_GAIN[stat] (share_i = FALLOFF**i) for
        # every stat in positive tier i, pulling them up together in priority
        # proportion (co-tier stats share). Then bake the achieved gains as floors and
        # let the weighted total maximize within. Negative tiers only adjust the weight.
        bias_shares = [(stat, BIAS_BOOST_FALLOFF ** idx)
                       for stat, (sign, idx) in bias_ranks(bias_tiers).items() if sign > 0]
        if bias_shares:
            t = pulp.LpVariable(f"bias_t_{start}", lowBound=0)
            for stat, share in bias_shares:
                prob += exprs[stat] >= share * MAX_GAIN[stat] * t
            prob.setObjective(-t)   # maximize t
            prob.solve(cbc)
            if not solved_ok(prob):
                continue
            t_opt = t.value() or 0.0
            for stat, share in bias_shares:
                prob += exprs[stat] >= int(share * MAX_GAIN[stat] * t_opt)   # bake floor

        # Balanced total-stat objective (integer eff_weights). --maximize sits above
        # it via the pinned lex optima. Fixes the optimal SCORE (the stat-vector may
        # still be a degenerate tie).
        total_stats = pulp.lpSum(eff_weights[k] * exprs[k] for k in STATS)
        prob.setObjective(-total_stats)
        prob.solve(cbc)
        if not solved_ok(prob):
            continue
        c10, c100, c200 = read_counts(x10, x100, x200)
        s = stats_of(start, c10, c100, c200, base_st=base_st)
        opt_score = sum(eff_weights[k] * s[k] for k in STATS)

        # Deterministic tie-break: hold the optimal score as a floor, then maximize each
        # TIEBREAK_ORDER stat in turn, locking the achieved value. Collapses the
        # degenerate optima to one canonical stat-vector that any exact MILP engine
        # reaches -- so CBC here and HiGHS in the web app return the same stats. Mirrors
        # step 4 of solveStart in src/solver.js.
        prob += total_stats >= opt_score   # score floor: never trade score for a favored stat
        for stat in TIEBREAK_ORDER:
            prob.setObjective(-exprs[stat])
            prob.solve(cbc)
            if not solved_ok(prob):
                break
            prob += exprs[stat] >= round(exprs[stat].value())   # lock the achieved value
        c10, c100, c200 = read_counts(x10, x100, x200)
        s = stats_of(start, c10, c100, c200, base_st=base_st)
        # Quality key (smaller = better): --maximize optima first (higher value sorts
        # first), then the bias-weighted score, then the same combat-first tie-break so
        # the winning START is deterministic across engines too.
        quality = (tuple(-opt for opt in lex_opts), -opt_score,
                   tuple(-s[k] for k in TIEBREAK_ORDER))
        if best is None or quality < best[0]:
            best = (quality, s)

    if best is None:
        return []   # no start vocation can satisfy the constraints
    target = best[1]   # the optimal final stats every returned build must hit

    # ---- Phase 2: enumerate distinct builds reaching the EXACT optimal stats. ----
    # Pin all six stats to `target` and walk distinct (vocation, tier) allocations via
    # no-good cuts, across every start in order (fighter/strider/mage), up to `count`.
    # Pinning all six stats subsumes the objective/bounds/match/bias, so this is a pure
    # feasibility enumeration -- the direct analogue of the web's sameStatsBuilds. With
    # the default count=1 it returns just the optimum; a larger count surfaces alternate
    # leveling paths to the same result, and it never invents worse-stat builds.
    builds = []
    for start in starts:
        if len(builds) >= count:
            break
        prob, x10, x100, x200, tiers, exprs = structural_model(start)
        for k in STATS:
            prob += exprs[k] == target[k]
        prob.setObjective(pulp.lpSum([]))   # feasibility only; all solutions tie on stats
        cut_id = 0
        while len(builds) < count:
            prob.solve(cbc)
            if not solved_ok(prob):
                break  # no more distinct same-stats builds for this start
            c10, c100, c200 = read_counts(x10, x100, x200)
            s = stats_of(start, c10, c100, c200, base_st=base_st)
            builds.append((penalty(s, eval_cons), start, c10, c100, c200, s))

            # No-good cut: force the next solution to differ from this one in at least
            # one variable. For each var x_i with value v_i, a binary g_i (=> x_i >=
            # v_i+1) and l_i (=> x_i <= v_i-1); require sum(g+l) >= 1.
            inds = []
            for xs, vocs, U in tiers:
                vals = {v: int(round(xs[v].value())) for v in vocs}
                for v in vocs:
                    vi, xi = vals[v], xs[v]
                    g = pulp.LpVariable(f"g{start}_{cut_id}_{xs[v].name}", cat="Binary")
                    l = pulp.LpVariable(f"l{start}_{cut_id}_{xs[v].name}", cat="Binary")
                    prob += xi >= (vi + 1) - (vi + 1) * (1 - g)   # g=1 => xi >= vi+1
                    prob += xi <= (vi - 1) + (U + 1) * (1 - l)    # l=1 => xi <= vi-1
                    inds += [g, l]
            prob += pulp.lpSum(inds) >= 1
            cut_id += 1

    return builds

class _SpacedHelpFormatter(argparse.RawTextHelpFormatter):
    """Help formatter that preserves newlines in description, epilog, and option
    help text, and adds a blank line after every option so the list breathes."""
    def _format_action(self, action):
        return super()._format_action(action) + '\n'

def parse_args():
    """Define and parse command-line arguments; return the argparse Namespace."""
    weights_desc = '\n'.join(
        f"{w:2s} = stamina {WEIGHTS[w]}, regen {WEIGHT_STAREGEN[w][0]}/s "
        f"({WEIGHT_STAREGEN[w][1]}), encumbrance {WEIGHT_ENCUMBRANCE[w]}kg  -  {WEIGHT_RANGES[w]}"
        for w in WEIGHTS
    ).replace('%', '%%')

    ap = argparse.ArgumentParser(
        formatter_class=_SpacedHelpFormatter,
        description=c("\n  \U0001f409  ddda-build-solver \U00002014 Dragon's Dogma™ level-200 build solver\n",
                      'bold', 'cyan') +
                    "  Find a build whose final stats meet your targets. Each stat takes an\n"
                    "  optional min and/or max (omit one to leave it unbounded), or an exact\n"
                    "  value. The ILP solver adds extra goals: divisor rounding,\n"
                    "  match, bias, and maximize.",
        epilog=c("\nexamples:\n", 'bold', 'yellow') +
               "  # minimum HP and stamina, everything else unconstrained\n"
               "  ddda-build-solver.py --hp-min 3600 --st-min 4000\n\n"
               "  # pin attack to an exact value, output 3 distinct builds\n"
               "  ddda-build-solver.py --attack 550 --count 3\n\n"
               "  # keep physical and magick stats equal\n"
               "  ddda-build-solver.py --match attack=mattack,defense=mdefense\n\n"
               "  # round HP to a multiple of 1000, machine-readable output\n"
               "  ddda-build-solver.py --weight LL --divisor hp=1000 --json\n")

    g_stats = ap.add_argument_group(c('\U0001f3af  stat targets', 'bold'),
        "Per stat: --STAT pins an exact value; --STAT-min / --STAT-max set bounds.\n"
        "An exact value overrides that stat's min/max. A stat with no bound is left\n"
        "unconstrained.")
    for stat in STATS:
        g_stats.add_argument(f'--{stat}', type=int, default=None, metavar='N',
                             help=f'exact {stat} (overrides --{stat}-min/--{stat}-max)')
        g_stats.add_argument(f'--{stat}-min', type=int, default=None, metavar='N',
                             help=f'minimum {stat}')
        g_stats.add_argument(f'--{stat}-max', type=int, default=None, metavar='N',
                             help=f'maximum {stat}')
    # Accept British-spelling aliases for the same stat (e.g. --defence -> defense),
    # writing to the canonical dest so the rest of main() is unaffected.
    for alias, canon in STAT_ALIASES.items():
        g_stats.add_argument(f'--{alias}', dest=canon, type=int, default=None,
                             metavar='N', help=f'alias for --{canon}')
        g_stats.add_argument(f'--{alias}-min', dest=f'{canon}_min', type=int,
                             default=None, metavar='N', help=argparse.SUPPRESS)
        g_stats.add_argument(f'--{alias}-max', dest=f'{canon}_max', type=int,
                             default=None, metavar='N', help=argparse.SUPPRESS)

    g_goals = ap.add_argument_group(c('\U00002728  ILP-only goals', 'bold'),
        "Extra constraints honored only by the exact (ILP) solver.")
    g_goals.add_argument('--divisor', type=str, default='', metavar='SPEC',
                         help="force stats to a multiple of a divisor\n"
                              "(max bound dropped, min kept as a floor).\n"
                              "a bare number applies to all stats:\n"
                              "  --divisor 100  -> every stat a multiple of 100\n"
                              "  (50 = half-perfect, 10 = round decimal)\n"
                              "or per-stat 'stat=N' segments, comma-separated:\n"
                              "  --divisor attack=10,mattack=20\n"
                              "groups work too (all=,combat=); later segments win.\n"
                              "stats: " + ','.join(STATS) + " (or 'all' / 'combat')")
    g_goals.add_argument('--match', type=str, default='', metavar='PAIRS',
                         help="comma-separated stat pairs tied together:\n"
                              "'a=b' forces equal values; 'a~b' lets them differ\n"
                              f"by up to {MATCH_TILDE_TOLERANCE} (e.g. attack~mattack -> 490 / 500),\n"
                              f"or {MATCH_TILDE_TOLERANCE_VITALS} for the hp~st pair.\n"
                              "e.g. 'attack=mattack,defense~mdefense'. 'all' expands\n"
                              "to attack=mattack,defense=mdefense,hp=st.\n"
                              "(each stat's own min/max still applies)")
    g_goals.add_argument('--require', type=str, default='', metavar='SPEC',
                         help="force a vocation to take at least N levels in a range,\n"
                              "as comma-separated segments: 'voc=N' (the 10->100\n"
                              "range) or 'voc:RANGE=N' where RANGE is 10 / 100 / 200.\n"
                              "e.g. --require warrior=40,fighter:10=9,sorcerer:200=30\n"
                              "(ranges hold 9 / 90 / 100 levels; per-range minimums\n"
                              "must fit; 1->10 is basics only). a required vocation is\n"
                              "also allowed. vocations: " + ', '.join(ALL))
    g_goals.add_argument('--bias', type=str, default='', metavar='SPEC',
                         help="comma-separated 'stat=N' weights softly favoring (N>0)\n"
                              "or reducing (N<0) a stat in the objective, N in -5..5\n"
                              "(matches the web UI's per-stat slider). Larger |N| =\n"
                              "stronger; stats sharing |N| and sign are weighted\n"
                              "equally. e.g. --bias attack=5,mattack=3,mdefense=3 favors\n"
                              "attack most, then mattack and mdefense together. A bare\n"
                              "stat means =5; groups all/combat expand (combat=4).\n"
                              "stats: " + ','.join(STATS) + " (or 'all' / 'combat')")
    g_goals.add_argument('--maximize', type=str, default='', metavar='STATS',
                         help="comma-separated stats to hard-maximize, highest\n"
                              "priority first, e.g. 'attack,defense' maxes attack\n"
                              "then maxes defense without giving up attack.\n"
                              "the TOP priority: each is pushed to its global\n"
                              "optimum FIRST (over the build structure only), then\n"
                              "your min/max/divisor/match targets apply within it.\n"
                              "a target that conflicts with the peak is INFEASIBLE,\n"
                              "not silently lowered (--maximize attack --hp-min 3220\n"
                              "is like --attack <max> --hp-min 3220).\n"
                              "stats: " + ','.join(STATS) + " (or 'all' / 'combat')")

    g_char = ap.add_argument_group(c('\U0001f4aa  character', 'bold'))
    g_char.add_argument('--weight', choices=list(WEIGHTS), default='M', metavar='CLASS',
                        type=lambda s: s.upper(),  # accept ss / Ss / sS as SS, etc.
                        help="weight class -> base stamina, regen, encumbrance:\n" + weights_desc +
                             "\n(default: M; case-insensitive)")
    g_char.add_argument('--avoid', type=str, default='', metavar='VOCS',
                        help="comma-separated vocations to drop from consideration\n"
                             "(not leveled in any range). vocations:\n"
                             + ', '.join(ALL))
    g_char.add_argument('--start-as', dest='start_as', type=str, default='',
                        metavar='VOC', choices=['', *BASIC],
                        help="force the starting (level-1) vocation to one basic:\n"
                             + '/'.join(BASIC) + ".\nby default the solver picks the "
                             "best-scoring start\namong the allowed basics. Honored by "
                             "both solvers.")
    g_char.add_argument('--pawn', action='store_true',
                        help="build for a pawn: excludes " + ','.join(PAWN_EXCLUDED) +
                             "\n(like --avoid), and enforces the pawn 1->10 rule\n"
                             "(>=1 of the nine 1->10 levels in the start vocation,\n"
                             "since a pawn can't switch vocation at level 1)")
    g_char.add_argument('--no-early-switcheroo', action='store_true',
                        help="forbid changing vocation before level 10: all nine\n"
                             "1->10 levels stay in the start vocation (no Hard Mode\n"
                             "restart trick). Honored by both solvers.")

    g_solver = ap.add_argument_group(c('\U0001f9ee  solver', 'bold'))
    g_solver.add_argument('--solver', choices=['auto', 'ilp', 'search'], default='auto',
                          help="auto   = ILP if PuLP installed, else search (default)\n"
                               "ilp    = exact PuLP solver\n"
                               "search = stochastic hill-climb")
    g_solver.add_argument('--count', type=int, default=1, metavar='N',
                          help='number of builds to output (default: 1). builds\n'
                               'beyond the first are alternate leveling paths that\n'
                               'reach the SAME optimal stats, not worse-stat builds;\n'
                               'fewer than N come back if the optimum is unique')
    g_solver.add_argument('--seed', type=int, default=0, metavar='N',
                          help='base RNG seed; runs are reproducible per seed (default: 0)')
    g_solver.add_argument('--seeds', type=int, default=8, metavar='N',
                          help='search: random restarts to try (default: 8)')
    g_solver.add_argument('--iters', type=int, default=1500000, metavar='N',
                          help='search: iterations per seed (default: 1500000)')
    g_solver.add_argument('--verbose-cbc', action='store_true',
                          help='ilp: print the CBC solver log (msg=True);\n'
                               'ignored under --json to keep output parseable')

    g_out = ap.add_argument_group(c('\U0001f5a5\U0000fe0f   output', 'bold'))
    g_out.add_argument('--json', action='store_true',
                       help='emit JSON instead of human-readable tables')
    g_out.add_argument('--import', dest='import_file', metavar='FILE',
                       help="re-render a JSON document saved earlier\n"
                            "(from `ddda-build-solver.py --json > FILE`):\n"
                            "reproduces the human-readable tables and prints\n"
                            "the exact command line that produced it, without\n"
                            "re-solving. Use '-' to read from stdin.\n"
                            "all other solve options are ignored.")
    g_out.add_argument('--no-color', action='store_true',
                       help='disable ANSI colors (also auto-off when not a TTY)')
    g_out.add_argument('--charset', choices=['auto', 'unicode', 'ascii'], default='auto',
                       help="box-drawing characters:\n"
                            "auto    = pick by locale (default)\n"
                            "unicode = clean borders on UTF-8 terminals\n"
                            "ascii   = 7-bit fallback")

    return ap.parse_args()

def run_search(cons, a, count=1, base_st=None, allowed=None, start_pool=None, show_progress=False,
               pawn=False, no_early_switch=False):
    """Search across random restarts; return (builds, interrupted).

    `builds` is a list of feasible builds (penalty 0), distinct by their vocation
    distribution; if none are feasible it's a single-element list with the closest
    build found (penalty > 0). `interrupted` is True if the search was Ctrl+C'd,
    in which case `builds` reflects the best found before the interrupt.

    When ``show_progress`` is set, a single in-place progress line (restarts done
    / total, percentage) is written to stderr while the search runs.
    """
    found, seen, closest = [], set(), None
    # widen the restart budget when asked for several builds
    n_seeds = max(a.seeds, count * a.seeds)
    total = n_seeds * SEARCH_RESTARTS   # total restarts across all seeds
    interrupted = False

    prog = None
    if show_progress:
        done_before = 0   # restarts completed in prior seeds
        spin = '|/-\\'
        def prog(restart_in_seed):
            done = done_before + restart_in_seed
            ch = spin[done % len(spin)]
            sys.stderr.write(f"\r  {ch} search: {done}/{total} restarts "
                             f"({done * 100 // total}%), {len(found)}/{count} builds")
            sys.stderr.flush()

    def record(cand):
        """Track the closest build and collect distinct feasible ones."""
        nonlocal closest
        if cand is None:
            return
        if closest is None or cand[0] < closest[0]:
            closest = cand
        if cand[0] == 0:
            key = (cand[1], *(tuple(sorted(cand[r].items())) for r in (2, 3, 4)))
            if key not in seen:
                seen.add(key)
                found.append(cand)

    try:
        for i in range(n_seeds):
            random.seed(a.seed + i)
            record(search(cons, iters=a.iters, base_st=base_st, allowed=allowed,
                          start_pool=start_pool, progress=prog, pawn=pawn,
                          no_early_switch=no_early_switch))
            if show_progress:
                done_before = (i + 1) * SEARCH_RESTARTS
            if len(found) >= count:
                break
    except (KeyboardInterrupt, SearchInterrupted) as e:
        interrupted = True
        record(getattr(e, 'best', None))

    if show_progress:
        sys.stderr.write("\r" + " " * 60 + "\r")   # clear the progress line
        sys.stderr.flush()
    return (found if found else [closest]) if closest is not None else [], interrupted

def _clean(c):
    """Drop zero-count vocations from a level-distribution dict."""
    return {k: v for k, v in c.items() if v > 0}

VOC_ORDER = ['fighter','strider','mage','warrior','ranger','sorcerer','mknight','assassin','marcher']

# Per-vocation display colors. A single style colors the whole word; a 2-tuple
# splits the word in half — first style on the first half, second on the rest
# (order matters).
VOC_COLORS = {
    'fighter':  'red',
    'strider':  'yellow',
    'mage':     'blue',
    'warrior':  'red',
    'ranger':   'yellow',
    'sorcerer': 'blue',
    'mknight':  ('red', 'blue'),
    'assassin': ('red', 'yellow'),
    'marcher':  ('yellow', 'blue'),
}

def _color_voc(v):
    """Color a vocation name per VOC_COLORS; dual-color names split at the midpoint."""
    style = VOC_COLORS.get(v, 'magenta')
    if isinstance(style, tuple):
        mid = len(v) // 2
        return c(v[:mid], style[0]) + c(v[mid:], style[1])
    return c(v, style)

def _fmt_levels(counts):
    """Format a level distribution for display, e.g. 'sorcerer x100'.

    Lists vocations in canonical VOC_ORDER, skipping zeros, with counts colored;
    returns a dimmed dash when the distribution is empty.
    """
    items = [(v, counts[v]) for v in VOC_ORDER if counts.get(v, 0) > 0]
    return '  '.join(f"{_color_voc(v)} {c(GLYPH['mul']+str(n),'bold')}" for v, n in items) or c(GLYPH['dash'], 'dim')

def print_build(idx, build, cons, rounding=None, weight=None, bias_tiers=(), bias_map=None):
    """Print one build as a colored header plus leveling-plan and final-stats tables.

    Args:
        idx: 1-based build number for the header.
        build: tuple (penalty, start, c10, c100, c200, stats).
        cons: constraints dict, used to color/annotate each final stat.
        rounding: {stat: int divisor} map; these stats' max bound is ignored
            when judging requirements, and annotated (e.g. "x100") in the
            details column.
        weight: optional weight-class name; when given, its class / range /
            base stamina / regen are appended as rows to the final-stats table.
        bias_tiers: list of (sign, [stats]) bias tiers (drives the solver weights).
        bias_map: {stat: signed int} magnitude per stat (the -5..+5 the user gave);
            shown in the details column as "bias +5" / "bias -3". Falls back to the
            1-based tier number when absent (e.g. older JSON without bias_map).
    """
    p,start,c10,c100,c200,s = build
    rounding = dict(rounding or {})
    # map stat -> signed bias label. Prefer the explicit magnitude (matches the web
    # UI's -5..+5); fall back to the signed 1-based tier when only tiers are known.
    if bias_map:
        bias_note = {st: f"bias {'+' if m > 0 else '-'}{abs(m)}" for st, m in bias_map.items() if m}
    else:
        bias_note = {st: f"bias {'+' if sign > 0 else '-'}{idx + 1}"
                     for st, (sign, idx) in bias_ranks(bias_tiers).items()}

    head = c(f"build {idx}", 'bold', 'white')
    status = c(f"{GLYPH['ok']} all requirements met", 'bold', 'green') if p == 0 \
        else c(f"{GLYPH['bad']} closest found (penalty {p:g})", 'bold', 'red')
    print(f"\n{c(GLYPH['heavy']*52,'cyan')}")
    print(f" {head}   {status}")
    print(f"{c(GLYPH['heavy']*52,'cyan')}")

    # leveling plan table (start vocation is the first row)
    a = GLYPH['arrow']
    plan = render_table(
        ["range", "levels", "vocations"],
        [
            [c("start",'yellow'),      c(GLYPH['dash'],'dim'), _color_voc(start)],
            [c(f"1{a}10",'yellow'),    c("9",'dim'),   _fmt_levels(c10)],
            [c(f"10{a}100",'yellow'),  c("90",'dim'),  _fmt_levels(c100)],
            [c(f"100{a}200",'yellow'), c("100",'dim'), _fmt_levels(c200)],
        ],
        aligns=['left', 'right', 'left'],
        title="leveling plan",
    )
    print(plan)
    # Pre-level-10 vocation change warning: normally you can't switch vocations
    # before level 10, so any 1->10 level in a vocation other than the start
    # requires the Hard Mode restart trick.
    if any(v != start and n > 0 for v, n in c10.items()):
        print(c(" ⚠  changing vocation before level 10:", 'yellow', 'bold'))
        print(c("    to do it, restart the game in Hard Mode — this resets save", 'yellow'))
        print(c("    progress, but the character keeps its levels and items.", 'yellow'))
    # Vocation switches: each range's distinct vocations form that many leveling
    # stints (blocks); a switch is needed to enter every block except the first.
    blocks = sum(len(_clean(cc)) for cc in (c10, c100, c200))
    switches = max(0, blocks - 1)
    print(f" vocation switches: {c(str(switches), 'bold')} "
          + c(f"({blocks} leveling blocks across the 3 ranges)", 'dim'))

    # final stats table, each value colored by whether it satisfies its bound
    rows = []
    for k in STATS:
        lo, hi = cons[k]
        hi_eff = None if k in rounding else hi
        ok = (lo is None or s[k] >= lo) and (hi_eff is None or s[k] <= hi_eff)
        val = c(str(s[k]), 'green' if ok else 'red', 'bold')
        bound = []
        if lo is not None: bound.append(f"{GLYPH['ge']}{lo}")
        if hi_eff is not None: bound.append(f"{GLYPH['le']}{hi_eff}")
        if k in rounding: bound.append(f"{GLYPH['mul']}{rounding[k]}")
        if k in bias_note: bound.append(bias_note[k])
        rows.append([c(k,'cyan'), val, c(' '.join(bound) or GLYPH['dash'], 'dim')])
    # summary totals
    combat = s['attack'] + s['mattack'] + s['defense'] + s['mdefense']
    vitals = s['hp'] + s['st']
    grand  = combat + vitals
    sep = c(GLYPH['h'] * 3, 'dim')
    rows.append([sep, sep, sep])
    rows.append([c('combat', 'yellow'), c(str(combat), 'yellow', 'bold'),
                 c('attack+mattack+defense+mdefense', 'dim')])
    rows.append([c('vitals', 'yellow'), c(str(vitals), 'yellow', 'bold'),
                 c('hp + st', 'dim')])
    rows.append([c('total', 'yellow'), c(str(grand), 'yellow', 'bold'),
                 c('all stats', 'dim')])
    # weight class block (merged in from the former standalone table)
    if weight is not None:
        regen, regen_pct = WEIGHT_STAREGEN[weight]
        rows.append([sep, sep, sep])
        rows.append([c('weight class', 'cyan'), c(weight, 'magenta', 'bold'),
                     c(WEIGHT_RANGES[weight], 'dim')])
        rows.append([c('base st', 'cyan'), c(str(WEIGHTS[weight]), 'bold'),
                     c('base stamina', 'dim')])
        rows.append([c('st regen', 'cyan'), c(f"{regen}/s", 'bold'),
                     c(f"{regen_pct} of M", 'dim')])
        rows.append([c('encumbrance', 'cyan'), c(f"{WEIGHT_ENCUMBRANCE[weight]}kg", 'bold'),
                     c('base maximum encumbrance', 'dim')])
    print(render_table(
        ["stat", "value", "details"],
        rows, aligns=['left', 'right', 'left'], title="final stats",
    ))
    # Shareable link to the owoc.github.io planner pre-filled with this build.
    print(" " + c("owoc planner: ", 'dim') + c(owoc_url(build), 'cyan'))
    # The owoc planner has no weight-class field and always assumes M, which sets
    # base stamina; for any other class its st total will differ slightly from
    # ours (this tool is the source of truth for st). The other five stats match.
    if weight is not None and weight != 'M':
        print(c(f"  (planner assumes weight M; this {weight} build's st will read "
                f"differently there — st here is authoritative)", 'dim', 'yellow'))

def print_constraints(cons, exact, rounding, match, bias_tiers, avoid, bias_map=None):
    """Print the banner, the 'avoiding' line, and the target-constraints table.

    Args mirror the parsed inputs from main(): cons {stat:(min,max)}, the exact
    stat list, rounding {stat:int divisor}, match triples (a, b, tol; tol 0 =
    equal, tol>0 = within tol), bias_tiers, and the set of avoided vocations.
    Stats linked by an exact match show their group-intersected bounds; the bias
    column shows each stat's signed tier.
    """
    print(c(f"DDDA BUILD SOLVER {GLYPH['dash']} LEVEL 200", 'bold', 'cyan'))
    if avoid:
        print(c("avoiding: ", 'bold') + c(', '.join(v for v in ALL if v in avoid), 'yellow'))

    # map each stat to the partner stats it matches (both directions), labeled
    # with the operator ('=' exact / '~' approximate) for the match column.
    match_partners = {k: [] for k in STATS}
    # exact-only adjacency, used to intersect bounds (only '=' stats share a value)
    exact_adj = {k: [] for k in STATS}
    for a_s, b_s, tol in match:
        op = '=' if tol == 0 else '~'
        match_partners[a_s].append(op + b_s)
        match_partners[b_s].append(op + a_s)
        if tol == 0:
            exact_adj[a_s].append(b_s)
            exact_adj[b_s].append(a_s)

    # group EXACT-matched stats into connected components (handles chains like
    # a=b,b=c). Such stats share one value, so their effective bounds are the
    # tightest floor (max of mins) and ceiling (min of maxes) across the group.
    # Approximate ('~') matches do not share a value, so they don't merge bounds.
    comp_of = {}
    for k in STATS:
        if k in comp_of:
            continue
        stack, comp = [k], []
        while stack:
            cur = stack.pop()
            if cur in comp_of:
                continue
            comp_of[cur] = None
            comp.append(cur)
            stack.extend(exact_adj[cur])
        mins = [cons[m][0] for m in comp if cons[m][0] is not None]
        maxs = [cons[m][1] for m in comp if cons[m][1] is not None]
        eff = (max(mins) if mins else None, min(maxs) if maxs else None)
        for m in comp:
            comp_of[m] = eff

    ranks = bias_ranks(bias_tiers)   # stat -> (sign, 0-based tier index)
    crows = []
    for k in STATS:
        lo, hi = comp_of[k]   # effective (group-intersected) bounds
        # single label for the stat's rounding (divisor) mode
        if k in rounding:
            round_label = c(f"{GLYPH['mul']}{rounding[k]}", 'green')
        else:
            round_label = c(GLYPH['dash'], 'dim')
        # signed bias: prefer the explicit -5..+5 magnitude (matches the web UI);
        # fall back to the signed 1-based tier when only tiers are known.
        if bias_map and bias_map.get(k):
            m = bias_map[k]
            bias_label = c(f"{'+' if m > 0 else '-'}{abs(m)}", 'green' if m > 0 else 'red')
        elif k in ranks:
            sign, idx = ranks[k]
            bias_label = c(f"{'+' if sign > 0 else '-'}{idx + 1}", 'green' if sign > 0 else 'red')
        else:
            bias_label = c(GLYPH['dash'], 'dim')
        partners = match_partners[k]
        crows.append([
            c(k,'cyan'),
            c(str(lo) if lo is not None else GLYPH['dash'], 'dim' if lo is None else None),
            c(str(hi) if hi is not None else GLYPH['dash'], 'dim' if hi is None else None),
            c('yes','green') if k in exact else c(GLYPH['dash'],'dim'),
            round_label,
            bias_label,
            c(', '.join(partners),'green') if partners else c(GLYPH['dash'],'dim'),
        ])
    print(render_table(
        ["stat", "min", "max", "exact", "round", "bias", "match"],
        crows, aligns=['left','right','right','center','center','center','left'],
        title="target constraints",
    ))

OWOC_BASE = "https://owoc.github.io"

def owoc_url(build):
    """Build a shareable link to the owoc.github.io planner for this build.

    The planner reads window.location.hash as a string of one-byte (2-hex-digit)
    fields (see its js/build.js readUrl):
      [0]      'a' patched / 'v' vanilla  -- we always emit 'a' (our growth data
               uses the patched, non-vanilla Magick Archer to200 values)
      [1]      start vocation: 'f' / 's' / 'm'
      [2:20]   10->100 level counts, one byte per vocation in VOC_ORDER
      [20:38]  100->200 level counts, same order
      [38:44]  1->10 counts for the three basic vocations (fighter/strider/mage)

    VOC_ORDER matches the planner's `vocs` array exactly. Our solver only ever
    levels basic vocations in the 1->10 range (mirroring the game), and the
    planner likewise has 1->10 fields only for the basics, so every build we
    produce maps onto the planner losslessly.
    """
    _, start, c10, c100, c200, _ = build
    hb = lambda n: format(int(n), '02x')
    s = 'a' + {'fighter': 'f', 'strider': 's', 'mage': 'm'}[start]
    s += ''.join(hb(c100.get(v, 0)) for v in VOC_ORDER)
    s += ''.join(hb(c200.get(v, 0)) for v in VOC_ORDER)
    s += ''.join(hb(c10.get(v, 0)) for v in ('fighter', 'strider', 'mage'))
    return f"{OWOC_BASE}/#{s}"

def build_to_dict(build):
    """Convert a build tuple into a JSON-serializable dict for ``--json`` output."""
    p,start,c10,c100,c200,s = build
    return {
        "penalty": p,
        "feasible": p == 0,
        "start": start,
        "levels": {
            "to10":  _clean(c10),
            "to100": _clean(c100),
            "to200": _clean(c200),
        },
        "vocation_switches": max(0, sum(len(_clean(cc)) for cc in (c10, c100, c200)) - 1),
        "final_stats": s,
        "totals": {
            "combat": s['attack'] + s['mattack'] + s['defense'] + s['mdefense'],
            "vitals": s['hp'] + s['st'],
            "all": sum(s[k] for k in STATS),
        },
        "owoc_url": owoc_url(build),
    }

def render_imported(doc):
    """Re-render a JSON document (from ``--json``) as human-readable output.

    Reconstructs the solve context and build tuples stored in ``doc`` and reuses
    print_constraints()/print_build() so the tables match what the original run
    produced — no re-solving, so this works without PuLP and reproduces exactly
    what was captured. Also echoes the exact command line that produced the file.
    Returns a process exit code.
    """
    # The exact command line that produced this document (added by --json runs).
    cmd = doc.get("command") or {}
    line = cmd.get("line")
    if not line and isinstance(cmd.get("argv"), list):
        line = shlex.join(["ddda-build-solver.py"] + cmd["argv"])
    if line:
        print(c("command:", 'bold') + " " + line)
        print()

    # Rebuild the solve inputs from the stored context block.
    constraints = doc.get("constraints") or {}
    # legacy divisor-mode booleans (pre --divisor) -> integer divisor
    LEGACY_DIV = {'perfect': 100, 'half_perfect': 50, 'decimal': 10}
    cons, exact, rounding = {}, [], {}
    for k in STATS:
        info = constraints.get(k, {})
        cons[k] = (info.get("min"), info.get("max"))
        if info.get("exact"):
            exact.append(k)
        if info.get("divisor"):                 # current format
            rounding[k] = info["divisor"]
        else:                                   # fall back to legacy booleans
            for mode, d in LEGACY_DIV.items():
                if info.get(mode):
                    rounding[k] = d
        # ("nice" was a removed mode; older documents may still carry the flag —
        #  it's simply ignored now.)
    # match: accept new 3-element triples [a, b, tol] and older 2-element pairs
    # [a, b] (which were always exact, i.e. tol 0).
    match = [(p[0], p[1], p[2] if len(p) > 2 else 0) for p in (doc.get("match") or [])]
    # Prefer the structured bias_tiers (keeps grouping + sign); fall back to the
    # flat bias list (one stat per positive tier) for older documents.
    if doc.get("bias_tiers"):
        bias_tiers = [(t.get("sign", 1), list(t.get("stats", []))) for t in doc["bias_tiers"]]
    else:
        bias_tiers = [(+1, [s]) for s in (doc.get("bias") or [])]
    # bias_map (the explicit -5..+5 per stat) drives the display labels; absent in
    # older documents, where print_* falls back to the signed tier number.
    bias_map = doc.get("bias_map") or None
    avoid = set(doc.get("avoided_vocations") or [])
    weight = (doc.get("weight") or {}).get("class")

    print_constraints(cons, exact, rounding, match, bias_tiers, avoid, bias_map=bias_map)

    solver = doc.get("solver")
    if solver == 'ilp':
        print(c("\nsolver: ", 'dim') + c("ILP (exact)", 'green'))
    elif solver == 'search':
        print(c("\nsolver: ", 'dim') + c("search (stochastic hill-climb)", 'yellow'))

    # Infeasible / interrupted documents carry no builds; report them as the
    # original run would have, then stop.
    if doc.get("infeasible"):
        print(c(f"\n{GLYPH['bad']} INFEASIBLE", 'bold', 'red') +
              ": " + doc.get("message", "no build satisfies these constraints."))
        _print_imported_time(doc)
        return 0
    builds_json = doc.get("builds") or []
    if not builds_json:
        if doc.get("interrupted"):
            print(c("\nsearch interrupted before any build was evaluated.", 'yellow'))
        else:
            print(c("\n(the document contains no builds)", 'yellow'))
        _print_imported_time(doc)
        return 0

    count = doc.get("requested", len(builds_json))
    print(c(f"\nfound {len(builds_json)} build(s)", 'bold')
          + (c(f" (requested {count})", 'dim') if count and count > 1 else "") + ":")
    for i, bd in enumerate(builds_json, 1):
        build = _build_from_dict(bd)
        print_build(i, build, cons, rounding, weight=weight, bias_tiers=bias_tiers, bias_map=bias_map)
    if count and len(builds_json) < count:
        print(c(f"\n(only {len(builds_json)} distinct feasible build(s) could be produced for these constraints)", 'yellow'))
    _print_imported_time(doc)
    return 0

def _print_imported_time(doc):
    """Echo the stored solve time, if present, in the same style as a live run."""
    t = doc.get("solve_time_sec")
    if t is not None:
        print(c(f"\nsolve time: {t:.3f}s", 'dim'))

def _build_from_dict(bd):
    """Inverse of build_to_dict(): rebuild a (penalty,start,c10,c100,c200,stats) tuple.

    The stored level dicts are already zero-stripped (see _clean); that is fine,
    the renderers look up counts with .get(). final_stats keys are coerced to int.
    """
    levels = bd.get("levels", {})
    c10  = {k: int(v) for k, v in (levels.get("to10")  or {}).items()}
    c100 = {k: int(v) for k, v in (levels.get("to100") or {}).items()}
    c200 = {k: int(v) for k, v in (levels.get("to200") or {}).items()}
    stats = {k: int(bd["final_stats"][k]) for k in STATS}
    penalty = bd.get("penalty", 0 if bd.get("feasible") else 1)
    return (penalty, bd.get("start"), c10, c100, c200, stats)

def main():
    """CLI entry point: parse args, run the chosen solver, and print results.

    Parses and validates the stat bounds, rounding (divisor) modes, match pairs,
    bias tiers, maximize priorities, weight class, and avoided
    vocations, dispatches to the ILP or search solver, and emits either a JSON
    document (``--json``) or colored tables.
    """
    a = parse_args()
    if a.no_color:
        _set_color(False)
    if a.charset != 'auto':
        _set_charset(a.charset)

    # --import: re-render a previously saved --json document and exit. This path
    # ignores all the solve options (nothing is re-computed); it only replays
    # what the file captured, including the original command line.
    if a.import_file:
        try:
            if a.import_file == '-':
                doc = json.load(sys.stdin)
            else:
                with open(a.import_file) as fh:
                    doc = json.load(fh)
        except FileNotFoundError:
            print("error: --import file not found: " + a.import_file)
            sys.exit(1)
        except json.JSONDecodeError as e:
            print(f"error: --import file is not valid JSON ({e}); "
                  "it must be output from `ddda-build-solver.py --json`.")
            sys.exit(1)
        if not isinstance(doc, dict) or "builds" not in doc:
            print("error: --import file does not look like a solver JSON document "
                  "(no 'builds' key); produce it with `ddda-build-solver.py --json`.")
            sys.exit(1)
        sys.exit(render_imported(doc))

    # Build per-stat (min, max) bounds. An exact value (--<stat>) pins both,
    # overriding --<stat>-min/-max. Otherwise use whatever explicit bounds the user
    # gave; a stat with neither is left unconstrained (no built-in default floors).
    cons = {}
    exact = []
    for k in STATS:
        ev = getattr(a, k)
        if ev is not None:
            cons[k] = (ev, ev)
            exact.append(k)
            continue
        cons[k] = (getattr(a, f'{k}_min'), getattr(a, f'{k}_max'))
    count = max(1, a.count)

    def fail(msg):
        """Report an input error in the active output format and signal abort."""
        if a.json:
            print(json.dumps({"error": msg}, indent=2))
        else:
            print("error: " + msg)

    def bad_stats(flag, names, allow_groups=False):
        """If ``names`` has unknown stats, report via fail() and return True."""
        bad = [s for s in names if s not in STATS]
        if bad:
            extra = ',all' if allow_groups else ''
            fail(f"unknown stat(s) in {flag}: {','.join(bad)}; choices: {','.join(STATS)}{extra}")
        return bool(bad)

    def parse_stat_list(raw):
        """Split a comma-separated stat list, expanding group keywords.

        'all' -> every stat; 'combat' -> the four combat stats (the ones the
        balanced objective favors over hp/st: attack, defense, mattack, mdefense).
        British-spelling aliases (defence/mdefence) are normalized to canonical.
        """
        items = []
        for s in (x.strip() for x in raw.split(',') if x.strip()):
            s = STAT_ALIASES.get(s, s)
            if s == 'all':
                items.extend(STATS)
            elif s == 'combat':
                items.extend(['attack', 'defense', 'mattack', 'mdefense'])
            else:
                items.append(s)
        # de-dupe while preserving order (groups may overlap explicit entries)
        seen, out = set(), []
        for s in items:
            if s not in seen:
                seen.add(s); out.append(s)
        return out

    def parse_voc_list(raw):
        """Parse a comma-separated vocation list into a set (no group keywords)."""
        return {x.strip() for x in raw.split(',') if x.strip()}

    # --divisor: round stats to a multiple of an integer. A bare number applies
    # to every stat (--divisor 100); otherwise each comma-separated 'stat=N'
    # segment sets one stat's divisor (groups all/combat expand). Later segments
    # override earlier ones. Builds a {stat: divisor} map (exact stats skipped).
    rounding = {}   # {stat: int divisor}
    div_raw = a.divisor.strip()
    if div_raw:
        if div_raw.isdigit():
            d = int(div_raw)
            if d < 1:
                fail(f"--divisor value must be a positive integer, got '{div_raw}'")
                return
            for s in STATS:
                if s not in exact:
                    rounding[s] = d
        else:
            for seg in (p.strip() for p in div_raw.split(',') if p.strip()):
                if seg.count('=') != 1:
                    fail(f"bad --divisor segment '{seg}'; expected 'stat=N' "
                         "or a bare number like '100'")
                    return
                names_raw, dstr = seg.split('=')
                if not dstr.strip().isdigit() or int(dstr) < 1:
                    fail(f"--divisor for '{names_raw.strip()}' must be a positive "
                         f"integer, got '{dstr.strip()}'")
                    return
                names = parse_stat_list(names_raw)
                if bad_stats('--divisor', names, allow_groups=True):
                    return
                for s in names:
                    if s not in exact:   # an exact value overrides rounding
                        rounding[s] = int(dstr)


    # --maximize: hard lexicographic goal; --bias: soft weight boost.
    maximize = parse_stat_list(a.maximize)
    if bad_stats('--maximize', maximize):
        return

    # --bias: comma-separated 'stat=N' assignments giving each stat a signed
    # magnitude in -5..+5 (matches the web UI's per-stat dropdown). Positive favors,
    # negative reduces; larger magnitude = stronger. Stats are then grouped into
    # priority tiers by magnitude within each sign (highest magnitude = first/strongest
    # tier; equal magnitudes share a tier), exactly like the web's biasTiersFromMap.
    # So `--bias attack=5,mattack=3,mdefense=3` -> pos tiers [[attack],[mattack,mdefense]].
    # A 'stat' with no '=N' defaults to +5 (the strongest favor), so the old bare-stat
    # form still favors. Group keywords (all/combat) expand, sharing the segment's value.
    bias_map = {}   # stat -> signed int magnitude
    for seg in (p.strip() for p in a.bias.split(',') if p.strip()):
        if '=' in seg:
            body, _, num = seg.rpartition('=')
            try:
                mag = int(num)
            except ValueError:
                print(c(f"error: --bias expects 'stat=N' (integer); got '{seg}'.", 'red'))
                return
        else:
            body, mag = seg, 5   # bare stat -> strongest positive favor
        if not -5 <= mag <= 5:
            print(c(f"error: --bias magnitude must be -5..5; got {mag} in '{seg}'.", 'red'))
            return
        stats_in_seg = parse_stat_list(body)
        if bad_stats('--bias', stats_in_seg):
            return
        for s in stats_in_seg:
            bias_map[s] = mag   # later segments win on conflict
    # Build sign-grouped, magnitude-ordered tiers from the map (mirrors the web's
    # biasTiersFromMap): for each sign, group stats by |magnitude|, tiers in
    # descending-magnitude order. Magnitude 0 means neutral (no tier).
    pos_tiers, neg_tiers = [], []
    for sign, dest in ((1, pos_tiers), (-1, neg_tiers)):
        by_mag = {}
        for s in STATS:
            m = bias_map.get(s, 0)
            if (m > 0) != (sign > 0) or m == 0:
                continue
            by_mag.setdefault(abs(m), []).append(s)
        for mag in sorted(by_mag, reverse=True):
            dest.append(by_mag[mag])
    # bias_tiers carries a sign per tier: list of (sign, [stats]); +1 favor, -1 reduce
    bias_tiers = [(+1, t) for t in pos_tiers] + [(-1, t) for t in neg_tiers]
    bias = [s for _, t in bias_tiers for s in t]   # flat list, for table/JSON

    # --match: parse "a=b,c~d" into a list of (stat_a, stat_b, tol) triples.
    # '=' forces equal final values (tol 0); '~' allows them to differ by up to
    # MATCH_TILDE_TOLERANCE points. The keyword 'all' expands to the three
    # canonical exact pairings.
    match = []
    match_spec = a.match
    if match_spec.strip() == 'all':
        match_spec = 'attack=mattack,defense=mdefense,hp=st'
    for spec in (p.strip() for p in match_spec.split(',') if p.strip()):
        if spec.count('~') == 1 and '=' not in spec:
            op, approx = '~', True
        elif spec.count('=') == 1 and '~' not in spec:
            op, approx = '=', False
        else:
            fail(f"bad --match pair '{spec}'; expected 'stat=stat' (equal) "
                 f"or 'stat~stat' (within {MATCH_TILDE_TOLERANCE})")
            return
        a_stat, b_stat = (STAT_ALIASES.get(x.strip(), x.strip()) for x in spec.split(op))
        unknown = [x for x in (a_stat, b_stat) if x not in STATS]
        if unknown:
            fail(f"unknown stat(s) in --match: {','.join(unknown)}; choices: {','.join(STATS)}")
            return
        if a_stat == b_stat:
            fail(f"--match pair '{spec}' matches a stat with itself")
            return
        # '~' tolerance: the hp/st (vitals) pair gets the wider gap; otherwise 10.
        if not approx:
            tol = 0
        elif {a_stat, b_stat} == {'hp', 'st'}:
            tol = MATCH_TILDE_TOLERANCE_VITALS
        else:
            tol = MATCH_TILDE_TOLERANCE
        match.append((a_stat, b_stat, tol))

    base_st = WEIGHTS[a.weight]
    regen, regen_pct = WEIGHT_STAREGEN[a.weight]

    # --avoid (and its --pawn alias) drop vocations from consideration entirely:
    # they're removed from the pool used in every range. Basic vocations are also
    # candidate start vocations, so avoiding them shrinks the start choices too.
    avoid = parse_voc_list(a.avoid)
    if a.pawn:
        avoid |= set(PAWN_EXCLUDED)
    bad = avoid - set(ALL)
    if bad:
        fail(f"unknown vocation(s) in --avoid: {','.join(sorted(bad))}; choices: {','.join(ALL)}")
        return
    if avoid >= set(BASIC):
        fail("--avoid would drop all basic vocations (fighter/strider/mage); "
             "at least one must remain as a start vocation")
        return
    allowed = [v for v in ALL if v not in avoid]
    start_pool = [v for v in BASIC if v not in avoid]

    # --start-as: force the level-1 vocation to one basic. It must be a basic that
    # survived --avoid (a required/forced start is implicitly allowed). Pins the
    # start pool to that single vocation; honored by both solvers.
    if a.start_as:
        if a.start_as not in start_pool:
            fail(f"--start-as {a.start_as} is not an available basic start "
                 f"(it may be excluded by --avoid/--pawn); choices: {','.join(start_pool)}")
            return
        start_pool = [a.start_as]

    # --require: per-tier, per-vocation minimum levels, as comma-separated segments
    # 'voc=N' (10->100 by default) or 'voc:TIER=N' where TIER is 10 / 100 / 200.
    # Each voc must be allowed (a require implies allow, so we reject an avoided/
    # pawn-excluded one); 1->10 (TIER 10) is basics only; each N is 1..tier-size and a
    # tier's minimums must total <= that tier's size.
    REQ_TIER_SZ = {'to10': 9, 'to100': 90, 'to200': 100}
    SHORT_TO_TIER = {'10': 'to10', '100': 'to100', '200': 'to200'}
    require = {'to10': {}, 'to100': {}, 'to200': {}}   # per-tier {voc: min levels}
    req_raw = a.require.strip()
    if req_raw:
        for seg in (p.strip() for p in req_raw.split(',') if p.strip()):
            if seg.count('=') != 1:
                fail(f"bad --require segment '{seg}'; expected 'voc=N' or 'voc:TIER=N'")
                return
            lhs, nstr = (x.strip() for x in seg.split('='))
            vname, _, short = lhs.partition(':')
            short = short or '100'   # bare 'voc=N' means the 10->100 tier
            tier = SHORT_TO_TIER.get(short)
            if tier is None:
                fail(f"--require {lhs}: bad range '{short}'; use 10, 100, or 200")
                return
            if vname not in ALL:
                fail(f"unknown vocation in --require: '{vname}'; choices: {','.join(ALL)}")
                return
            if vname not in allowed:
                fail(f"--require {vname}: that vocation is excluded "
                     "(by --avoid/--pawn); can't require an excluded vocation")
                return
            if tier == 'to10' and vname not in BASIC:
                fail(f"--require {vname}:10 — only basic vocations (fighter/strider/mage) "
                     "can be leveled in the 1->10 range")
                return
            sz = REQ_TIER_SZ[tier]
            if not nstr.isdigit() or not (1 <= int(nstr) <= sz):
                fail(f"--require {lhs} must be a whole number from 1 to {sz}, got '{nstr}'")
                return
            require[tier][vname] = int(nstr)
        for tier, sz in REQ_TIER_SZ.items():
            tot = sum(require[tier].values())
            if tot > sz:
                short = {'to10': '1->10', 'to100': '10->100', 'to200': '100->200'}[tier]
                fail(f"--require minimums for {short} total {tot}, but only {sz} levels "
                     f"are available there; lower them to sum to {sz} or less")
                return

    # Shared JSON context: the exact command line plus every solve input, so a
    # saved --json document is self-describing and can be re-rendered (and the
    # original invocation reproduced) via --import without re-solving. Merged
    # into the normal, infeasible, and interrupted JSON docs alike.
    command = {
        "argv": sys.argv[1:],
        "line": shlex.join([os.path.basename(sys.argv[0])] + sys.argv[1:]),
    }
    context = {
        "weight": {
            "class": a.weight,
            "range": WEIGHT_RANGES[a.weight],
            "base_stamina": base_st,
            "stamina_regen_per_sec": regen,
            "stamina_regen_pct": regen_pct,
            "base_max_encumbrance": WEIGHT_ENCUMBRANCE[a.weight],
        },
        "constraints": {k: {"min": cons[k][0], "max": cons[k][1],
                            "exact": k in exact,
                            "divisor": rounding.get(k)} for k in STATS},
        "match": [[a_s, b_s, tol] for a_s, b_s, tol in match],
        "pawn": a.pawn,
        "no_early_switcheroo": a.no_early_switcheroo,
        "avoided_vocations": [v for v in ALL if v in avoid],
        "start_as": a.start_as or None,
        "require": require,
        "bias": bias,
        "bias_map": bias_map,
        "bias_tiers": [{"sign": sign, "stats": tier} for sign, tier in bias_tiers],
        "maximize": maximize,
    }

    if not a.json:
        print_constraints(cons, exact, rounding, match, bias_tiers, avoid, bias_map=bias_map)

    method = a.solver
    if method == 'auto':
        method = 'ilp' if HAVE_PULP else 'search'
        if not HAVE_PULP and not a.json:
            print(c("\nnote: PuLP not found \U0001f9ee❌ — using the stochastic search "
                    "solver. Install PuLP (e.g. `pip install pulp`) for the exact ILP "
                    "solver.", 'yellow'))
    if method == 'ilp' and not HAVE_PULP:
        if not a.json:
            print(c("\nnote: PuLP not found \U0001f9ee❌ — falling back to the "
                    "stochastic search solver. Install PuLP (e.g. `pip install pulp`) "
                    "for the exact ILP solver.", 'yellow'))
        method = 'search'

    solve_time = None   # ILP wall-clock seconds, reported in the summary
    if method == 'ilp':
        if not a.json:
            print(c("\nsolver: ", 'dim') + c("ILP (exact)", 'green'))
        _t0 = time.perf_counter()
        builds = solve_ilp(cons, count=count, rounding=rounding, match=match,
                           base_st=base_st,
                           allowed=allowed, maximize=maximize,
                           bias_tiers=bias_tiers,
                           start_pool=start_pool, verbose=a.verbose_cbc and not a.json,
                           time_limit=5, pawn=a.pawn,
                           no_early_switch=a.no_early_switcheroo, require=require)
        solve_time = time.perf_counter() - _t0
        if not builds:
            if a.json:
                print(json.dumps({
                    "command": command,
                    **context,
                    "feasible": False,
                    "solver": method,
                    "infeasible": True,
                    "message": "no build satisfies these constraints (proven by the ILP solver)",
                    "solve_time_sec": round(solve_time, 3),
                    "requested": count,
                    "found": 0,
                    "builds": [],
                }, indent=2))
            else:
                print(c(f"\n{GLYPH['bad']} INFEASIBLE", 'bold', 'red') +
                      ": no build satisfies these constraints (proven by the ILP solver).")
                print(c(f"solve time: {solve_time:.3f}s", 'dim'))
            return
    else:
        if not a.json:
            ilp_only = [('--divisor', a.divisor), ('--match', a.match),
                        ('--require', a.require),
                        ('--bias', a.bias), ('--maximize', a.maximize)]
            for flag, val in ilp_only:
                if val:
                    print(c(f"\nnote: {flag} is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            print(c("\nsolver: ", 'dim') + c("search (stochastic hill-climb)", 'yellow'))
        _t0 = time.perf_counter()
        builds, interrupted = run_search(cons, a, count=count, base_st=base_st, allowed=allowed,
                            start_pool=start_pool,
                            show_progress=not a.json and sys.stderr.isatty(), pawn=a.pawn,
                            no_early_switch=a.no_early_switcheroo)
        solve_time = time.perf_counter() - _t0
        if interrupted and not a.json:
            print(c("\nsearch interrupted — showing the best build found so far.", 'yellow', 'bold'))
        if not builds:
            if not a.json:
                print(c("\nsearch interrupted before any build was evaluated.", 'yellow'))
                print(c(f"solve time: {solve_time:.3f}s", 'dim'))
            else:
                print(json.dumps({"command": command, **context,
                                  "feasible": False, "solver": method,
                                  "interrupted": True,
                                  "solve_time_sec": round(solve_time, 3),
                                  "requested": count, "found": 0,
                                  "builds": []}, indent=2))
            return

    if a.json:
        doc = {
            "command": command,
            **context,
            "solver": method,
            "requested": count,
            "found": len(builds),
            "solve_time_sec": round(solve_time, 3) if solve_time is not None else None,
            "builds": [build_to_dict(b) for b in builds],
        }
        print(json.dumps(doc, indent=2))
        return

    print(c(f"\nfound {len(builds)} build(s)", 'bold') + (c(f" (requested {count})", 'dim') if count > 1 else "") + ":")
    for i, b in enumerate(builds, 1):
        print_build(i, b, cons, rounding, weight=a.weight, bias_tiers=bias_tiers, bias_map=bias_map)
    if len(builds) < count:
        print(c(f"\n(only {len(builds)} distinct feasible build(s) could be produced for these constraints)", 'yellow'))
    if solve_time is not None:
        print(c(f"\nsolve time: {solve_time:.3f}s", 'dim'))

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        # Ctrl+C outside the search loop (e.g. during the ILP solve or setup):
        # exit quietly without a traceback.
        sys.stderr.write("\naborted.\n")
        sys.exit(130)
