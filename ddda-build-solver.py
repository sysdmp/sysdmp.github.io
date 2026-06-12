#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 sysdmp
"""ddda-build-solver: Dragon's Dogma™: Dark Arisen level-200 build solver.

Finds character builds that meet target stat requirements (HP, stamina, attack,
defense, magick attack, magick defense) at level 200, given the game's
vocation-based stat-growth rules mirrored from ``js/planner.js``.

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

import random, argparse, json, sys, os

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
# plus heavy/light separators used outside tables.
_CHARSETS = {
    'unicode': dict(tl='┌', tr='┐', bl='└', br='┘', h='─', v='│',
                    tm='┬', bm='┴', lm='├', rm='┤', cross='┼',
                    heavy='━', mul='×', ok='✓', bad='✗', ge='≥', le='≤',
                    arrow='→', bullet='•', dash='—'),
    'ascii':   dict(tl='+', tr='+', bl='+', br='+', h='-', v='|',
                    tm='+', bm='+', lm='+', rm='+', cross='+',
                    heavy='=', mul='x', ok='[OK]', bad='[X]', ge='>=', le='<=',
                    arrow='->', bullet='*', dash='-'),
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

# --- data mirrored from js/planner.js ---
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
# Advanced vocations disabled by --pawn (vocations a pawn cannot take).
PAWN_EXCLUDED = ['mknight', 'marcher', 'assassin']
# Divisor-based "rounding" modes: each forces a stat to a multiple of its
# divisor. Keyed by the --flag name; 'nice' is handled separately (enumerated).
DIVISOR_MODES = {'perfect': 100, 'half_perfect': 50, 'decimal': 10}
# Built-in default (min, max) per stat, applied unless --no-default is given.
STAT_DEFAULTS = {
    'hp':       (3500, None),
    'st':       (3500, None),
    'attack':   (500,  None),
    'defense':  (300,  None),
    'mattack':  (500,  None),
    'mdefense': (300,  None),
}
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

# Character weight class sets base stamina. The data above assumes M (540).
WEIGHTS = {'SS': 500, 'S': 520, 'M': 540, 'L': 560, 'LL': 580}
# Body-weight range that determines each class (kg).
WEIGHT_RANGES = {
    'SS': 'under 50kg',
    'S':  '50-69kg',
    'M':  '70-89kg',
    'L':  '90-109kg',
    'LL': '110kg and over',
}
# Stamina recovery rate per second, with multiplier relative to M (100%).
WEIGHT_STAREGEN = {
    'SS': (53, '125%'),
    'S':  (48, '115%'),
    'M':  (42, '100%'),
    'L':  (38, '90%'),
    'LL': (31, '75%'),
}

def growth(voc, tier):
    """Return the per-level stat-gain dict for a vocation in a given tier.

    ``tier`` is one of 'to10', 'to100', 'to200'. Works for both basic and
    advanced vocations (advanced ones only define 'to100'/'to200').
    """
    if voc in basic: return basic[voc][tier]
    return adv[voc][tier]

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

def search(cons, iters=1500000, base_st=None, allowed=None):
    """Stochastic hill-climb for a feasible build (fallback when PuLP is absent).

    Performs random restarts, each starting from a random vocation distribution
    and repeatedly accepting single-level moves (and occasional start-vocation
    swaps) that do not worsen the penalty.

    Args:
        cons: dict {stat: (min, max)} target constraints.
        iters: total moves to attempt, split evenly across restarts.
        base_st: optional starting-stamina override (weight class).
        allowed: optional iterable restricting which vocations may be used in
            the 10->100 and 100->200 ranges (defaults to all). Basic vocations
            are always permitted in the 1->10 range.

    Returns:
        The best build found as a tuple
        (penalty, start, c10, c100, c200, stats). penalty 0 means feasible;
        a positive value means this is only the closest build found.
    """
    adv_pool = list(allowed) if allowed is not None else ALL
    best = None
    for restart in range(60):
        start = random.choice(BASIC)
        c10 = rand_counts(BASIC, 9)
        c100 = rand_counts(adv_pool, 90)
        c200 = rand_counts(adv_pool, 100)
        cur_p = penalty(stats_of(start,c10,c100,c200,base_st), cons)
        for it in range(iters//60):
            which = random.random()
            if which < 0.1:
                nstart = random.choice(BASIC); nc10,nc100,nc200=c10,c100,c200
                np_ = penalty(stats_of(nstart,nc10,nc100,nc200,base_st), cons)
                if np_<=cur_p:
                    start=nstart; cur_p=np_
                continue
            elif which < 0.2:
                m = neighbors_move(c10, BASIC);
                if m is None: continue
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
        s = stats_of(start,c10,c100,c200,base_st)
        cand = (cur_p, start, c10, c100, c200, s)
        if best is None or cand[0]<best[0]:
            best = cand
    return best

def is_nice(n):
    """Return True if ``n`` is a 'nice' number.

    Nice numbers are: anything ending in 42 or 69; or a repdigit (all digits
    identical, e.g. 444, 7777 — this also covers 666).
    """
    if n % 100 == 42: return True
    if n % 100 == 69: return True
    if len(set(str(n))) == 1: return True   # repdigit (e.g. 111, 4444, 666)
    return False

def nice_values(lo, hi):
    """List the nice numbers in the inclusive range [lo, hi] (sorted ascending)."""
    return [n for n in range(max(0, lo), hi + 1) if is_nice(n)]

def _stat_upper_bound(k, base, adv_pool=ALL):
    """Tight upper bound on stat ``k`` for a build starting from ``base``.

    Equals the base value plus the maximum possible per-level gain in each
    range; used only to bound the nice-value enumeration in the ILP. ``adv_pool``
    restricts the vocations available in the 10->100 and 100->200 ranges.
    """
    m10  = max(growth(v, 'to10')[k]  for v in BASIC)
    m100 = max(growth(v, 'to100')[k] for v in adv_pool)
    m200 = max(growth(v, 'to200')[k] for v in adv_pool)
    return base[k] + 9 * m10 + 90 * m100 + 100 * m200

def solve_ilp(cons, count=1, rounding=None, nice=(), match=(),
              minimize_vocations=False, base_st=None, allowed=None, bias=(), dump=(),
              weights=None):
    """Exact integer-linear solver. Returns a list of distinct feasible builds,
    each a tuple (penalty, start, c10, c100, c200, stats); penalty is always 0
    (constraints are modeled as hard). Returns [] if infeasible. Up to `count`
    builds are returned, gathered across the three start vocations; within a
    start, distinct solutions are enumerated with no-good cuts.

    `rounding` maps a stat name to a divisor mode ('perfect' -> multiple of 100,
    'half_perfect' -> 50, 'decimal' -> 10; see DIVISOR_MODES). The stat's value
    is forced to divisor*k via a fresh integer k, its max bound is dropped, and
    its min (if any) is kept as a floor.

    `nice` is a set of stat names that must each be a "nice" number (see
    ``is_nice``). Like the rounding modes, the max bound is dropped and the min
    kept as a floor; the value is forced into the enumerated nice set via binary
    selectors.

    `match` is an iterable of (stat_a, stat_b) pairs whose final values are
    constrained to be equal. Each stat's own min/max bounds still apply.

    `minimize_vocations`: when True, the dominant objective term minimizes the
    number of distinct vocations that receive any level-ups, so feasible builds
    that require fewer vocation changes are preferred.

    `allowed`: optional iterable restricting which vocations may be used in the
    10->100 and 100->200 ranges (defaults to all). Basic vocations are always
    permitted in the 1->10 range.

    `bias`: an ordered sequence of stat names to maximize, highest priority
    first, via sequential lexicographic optimization: the first stat is
    maximized, frozen at its optimum, then the next, and so on. An empty
    sequence (default) just maximizes the total stat sum (the "balance" mode).

    `dump`: an ordered sequence of stat names to minimize, highest priority
    first, via the same sequential lexicographic optimization as `bias` but
    minimizing. Ranked below all `bias` stats and above the total-stat
    maximization. Other constraints still hold.

    `weights`: per-stat weights for the balanced total-stat objective; defaults
    to BALANCE_WEIGHTS (hp/st discounted to 0.1). Pass all-1.0 weights to value
    every stat equally.
    """
    rounding = dict(rounding or {})
    nice = set(nice)
    weights = weights if weights is not None else BALANCE_WEIGHTS
    adv_pool = list(allowed) if allowed is not None else ALL
    candidates = []   # (quality_key, build) across all starts; sorted at the end
    # The start vocation only shifts the constant base stats, so solve one ILP
    # family per basic start, then pick the best builds across all of them — the
    # start is chosen by the resulting stats/objective, not by a fixed order.
    for start in BASIC:
        base = dict(basic[start]['init'])
        if base_st is not None:
            base['st'] = base_st   # weight class overrides the data's default (M=540)

        prob = pulp.LpProblem("build", pulp.LpMinimize)
        # integer count of level-ups taken in each (vocation, tier), with upper
        # bounds = the block size (used as big-M for the no-good cuts below).
        x10  = {v: pulp.LpVariable(f"x10_{v}",  lowBound=0, upBound=9,   cat="Integer") for v in BASIC}
        x100 = {v: pulp.LpVariable(f"x100_{v}", lowBound=0, upBound=90,  cat="Integer") for v in adv_pool}
        x200 = {v: pulp.LpVariable(f"x200_{v}", lowBound=0, upBound=100, cat="Integer") for v in adv_pool}
        # (var dict, vocations, block size) per range; reused for block-size
        # constraints, the minimize-vocations binding, and no-good cuts.
        tiers = [(x10, BASIC, 9), (x100, adv_pool, 90), (x200, adv_pool, 100)]

        # block sizes: 1->10 = 9 levels, 10->100 = 90, 100->200 = 100
        for xs, _, total in tiers:
            prob += pulp.lpSum(xs.values()) == total

        # each stat's final value as a linear expression
        exprs = {}
        for k in STATS:
            expr = base[k] \
                + pulp.lpSum(growth(v,'to10')[k]  * x10[v]  for v in BASIC) \
                + pulp.lpSum(growth(v,'to100')[k] * x100[v] for v in adv_pool) \
                + pulp.lpSum(growth(v,'to200')[k] * x200[v] for v in adv_pool)
            exprs[k] = expr
            lo, hi = cons[k]
            if k in rounding:
                # divisor mode: value == divisor*mult, min kept as floor, max dropped
                divisor = DIVISOR_MODES[rounding[k]]
                mult = pulp.LpVariable(f"round_{k}_{start}", lowBound=0, cat="Integer")
                prob += expr == divisor * mult
                if lo is not None: prob += expr >= lo
            elif k in nice:
                # nice mode: value must be one of the enumerated nice numbers in
                # [floor, reachable-max]. Pick exactly one via binary selectors.
                floor = lo if lo is not None else 0
                ub = _stat_upper_bound(k, base, adv_pool)
                choices = nice_values(floor, ub)
                if not choices:
                    # no nice value is reachable for this stat -> infeasible start
                    prob += expr <= -1   # trivially unsatisfiable
                else:
                    sel = {nv: pulp.LpVariable(f"nice_{k}_{nv}_{start}", cat="Binary") for nv in choices}
                    prob += pulp.lpSum(sel.values()) == 1
                    prob += expr == pulp.lpSum(nv * sel[nv] for nv in choices)
                if lo is not None: prob += expr >= lo
            else:
                if lo is not None: prob += expr >= lo
                if hi is not None: prob += expr <= hi

        # match mode: force paired stats to share the same final value.
        for a_stat, b_stat in match:
            prob += exprs[a_stat] == exprs[b_stat]

        # penalty is reported against constraints as actually enforced: rounding
        # and nice stats keep only their floor, so their dropped max isn't counted.
        relaxed = set(rounding) | nice
        eval_cons = {k: ((cons[k][0], None) if k in relaxed else cons[k]) for k in STATS}

        # Base objective (lexicographic via weight magnitudes; all minimized):
        #  1. --minimize-vocations (when set): fewest distinct vocations. Dominant.
        #  2. maximize the weighted total of final stats (BALANCE_WEIGHTS), so the
        #     balanced build favors raising combat stats over piling into hp/st.
        # The --bias / --dump stats sit ABOVE all of this and are handled by a
        # separate lexicographic pre-pass below (each optimized in turn, then
        # pinned). Fighter start is preferred separately, by trying starts in
        # BASIC order (fighter first) and stopping once `count` builds are found.
        # No per-vocation cosmetic preferences: the stat totals and the supplied
        # constraints alone dictate which vocations get leveled.
        W_VOC  = 10**9   # per used vocation; dominant
        W_STAT = 10**3   # per (weighted) stat point
        total_stats = pulp.lpSum(weights[k] * exprs[k] for k in STATS)
        base_objective = -W_STAT * total_stats

        if minimize_vocations:
            # A vocation is "used" if it receives any level in any tier. Bind a
            # binary used[v] so used[v]=1 whenever that vocation has levels, then
            # minimize the count of used vocations as the dominant term.
            used = {v: pulp.LpVariable(f"used_{v}_{start}", cat="Binary") for v in adv_pool}
            for xs, vocs, U in tiers:
                for v in vocs:
                    # if x[v] > 0 then used[v] must be 1 (x[v] <= U * used[v])
                    prob += xs[v] <= U * used[v]
            base_objective = W_VOC * pulp.lpSum(used.values()) + base_objective

        # --bias / --dump lexicographic pre-pass: optimize each listed stat in
        # priority order, freezing each at its optimum before moving on. All
        # --bias stats (maximize) rank above all --dump stats (minimize), so e.g.
        # `--bias attack,defense` maxes attack, then maxes defense without giving
        # up any attack; a following `--dump mattack` then minimizes mattack
        # without touching either. Skipped when both lists are empty.
        # Each entry is (stat, sense) where sense=+1 maximizes, -1 minimizes.
        lex_goals = [(s, +1) for s in bias] + [(s, -1) for s in dump]
        infeasible_start = False
        lex_opts = []   # the pinned bias/dump optima, in priority order
        for stat, sense in lex_goals:
            prob.setObjective(-sense * exprs[stat])  # minimize -> max/min per sense
            prob.solve(pulp.PULP_CBC_CMD(msg=0))
            if pulp.LpStatus[prob.status] != "Optimal":
                infeasible_start = True
                break
            opt = round(exprs[stat].value())
            lex_opts.append((sense, opt))
            if sense > 0:
                prob += exprs[stat] >= opt   # pin maximized optimum
            else:
                prob += exprs[stat] <= opt   # pin minimized optimum
        if infeasible_start:
            continue  # this start vocation cannot satisfy the constraints

        prob.setObjective(base_objective)

        # Enumerate up to `count` distinct builds for this start, best first.
        cut_id = 0
        for _ in range(count):
            prob.solve(pulp.PULP_CBC_CMD(msg=0))
            if pulp.LpStatus[prob.status] != "Optimal":
                break  # no more distinct builds for this start
            c10  = {v: int(round(x10[v].value()))  for v in BASIC}
            c100 = {v: int(round(x100[v].value())) for v in adv_pool}
            c200 = {v: int(round(x200[v].value())) for v in adv_pool}
            s = stats_of(start, c10, c100, c200, base_st=base_st)
            build = (penalty(s, eval_cons), start, c10, c100, c200, s)
            # Quality key mirroring the lexicographic objective (smaller = better),
            # so the winning start is chosen by stats/objective, not BASIC order:
            #  1. distinct vocation count, only when --minimize-vocations is set;
            #  2. bias maximize -> -value / dump minimize -> +value, priority order;
            #  3. the weighted stat total (maximize -> negate).
            n_vocs = len({v for cc in (c10, c100, c200) for v, n in cc.items() if n > 0})
            voc_key = (n_vocs,) if minimize_vocations else ()
            lex_key = tuple(-opt if sense > 0 else opt for sense, opt in lex_opts)
            wstat = sum(weights[k] * s[k] for k in STATS)
            quality = (voc_key, lex_key, -wstat)
            candidates.append((quality, build))

            # No-good cut: force the next solution to differ from this one in at
            # least one variable. For each var x_i with value v_i, a binary g_i
            # (=> x_i >= v_i+1) and l_i (=> x_i <= v_i-1); require sum(g+l) >= 1.
            inds = []
            for xs, vocs, U in tiers:
                vals = {v: int(round(xs[v].value())) for v in vocs}
                for v in vocs:
                    vi, xi = vals[v], xs[v]
                    g = pulp.LpVariable(f"g{cut_id}_{xs[v].name}", cat="Binary")
                    l = pulp.LpVariable(f"l{cut_id}_{xs[v].name}", cat="Binary")
                    prob += xi >= (vi + 1) - (vi + 1) * (1 - g)   # g=1 => xi >= vi+1
                    prob += xi <= (vi - 1) + (U + 1) * (1 - l)    # l=1 => xi <= vi-1
                    inds += [g, l]
            prob += pulp.lpSum(inds) >= 1
            cut_id += 1

    # Choose builds across all starts by quality (stats/objective), not by the
    # order starts were tried. Ties keep their first-seen (BASIC) order via the
    # stable sort, so fighter only wins genuine ties.
    candidates.sort(key=lambda ck: ck[0])
    return [build for _, build in candidates[:count]]

class _SpacedHelpFormatter(argparse.RawTextHelpFormatter):
    """Help formatter that preserves newlines in description, epilog, and option
    help text, and adds a blank line after every option so the list breathes."""
    def _format_action(self, action):
        return super()._format_action(action) + '\n'

def parse_args():
    """Define and parse command-line arguments; return the argparse Namespace."""
    weights_desc = '\n'.join(
        f"{w:2s} = stamina {WEIGHTS[w]}, regen {WEIGHT_STAREGEN[w][0]}/s "
        f"({WEIGHT_STAREGEN[w][1]})  -  {WEIGHT_RANGES[w]}"
        for w in WEIGHTS
    ).replace('%', '%%')

    ap = argparse.ArgumentParser(
        formatter_class=_SpacedHelpFormatter,
        description=c("\n  \U0001f409  ddda-build-solver \U00002014 Dragon's Dogma™ level-200 build solver\n",
                      'bold', 'cyan') +
                    "  Find a build whose final stats meet your targets. Each stat takes an\n"
                    "  optional min and/or max (omit one to leave it unbounded), or an exact\n"
                    "  value. The ILP solver adds extra goals: rounding (perfect / half-\n"
                    "  perfect / decimal / nice), match, bias / dump, and minimize-vocations.",
        epilog=c("\nexamples:\n", 'bold', 'yellow') +
               "  # minimum HP and stamina, everything else default\n"
               "  ddda-build-solver.py --hp-min 3600 --st-min 4000\n\n"
               "  # pin attack to an exact value, output 3 distinct builds\n"
               "  ddda-build-solver.py --attack 550 --count 3\n\n"
               "  # keep physical and magick stats equal, fewest vocation changes\n"
               "  ddda-build-solver.py --match attack=mattack,defense=mdefense --minimize-vocations\n\n"
               "  # heavy character, nice HP, machine-readable output\n"
               "  ddda-build-solver.py --weight LL --nice hp --json\n")

    g_stats = ap.add_argument_group(c('\U0001f3af  stat targets', 'bold'),
        "Per stat: --STAT pins an exact value; --STAT-min / --STAT-max set bounds.\n"
        "An exact value overrides that stat's min/max. Built-in default minimums\n"
        "apply unless overridden or --no-default is given.")
    for stat in STATS:
        lo, hi = STAT_DEFAULTS[stat]
        g_stats.add_argument(f'--{stat}', type=int, default=None, metavar='N',
                             help=f'exact {stat} (overrides --{stat}-min/--{stat}-max)')
        g_stats.add_argument(f'--{stat}-min', type=int, default=None, metavar='N',
                             help=f'minimum {stat} (default: {lo})')
        g_stats.add_argument(f'--{stat}-max', type=int, default=None, metavar='N',
                             help=f'maximum {stat} (default: {hi if hi is not None else "none"})')
    # Accept British-spelling aliases for the same stat (e.g. --defence -> defense),
    # writing to the canonical dest so the rest of main() is unaffected.
    for alias, canon in STAT_ALIASES.items():
        g_stats.add_argument(f'--{alias}', dest=canon, type=int, default=None,
                             metavar='N', help=f'alias for --{canon}')
        g_stats.add_argument(f'--{alias}-min', dest=f'{canon}_min', type=int,
                             default=None, metavar='N', help=argparse.SUPPRESS)
        g_stats.add_argument(f'--{alias}-max', dest=f'{canon}_max', type=int,
                             default=None, metavar='N', help=argparse.SUPPRESS)
    g_stats.add_argument('--no-default', action='store_true',
                         help='ignore the built-in default stat minimums;\n'
                              'only constraints you pass explicitly apply')

    g_goals = ap.add_argument_group(c('\U00002728  ILP-only goals', 'bold'),
        "Extra constraints honored only by the exact (ILP) solver.")
    g_goals.add_argument('--perfect', type=str, default='', metavar='STATS',
                         help="comma-separated stats forced to a multiple of 100\n"
                              "(max bound dropped, min kept as a floor)\n"
                              "stats: " + ','.join(STATS) + " (or 'all')")
    g_goals.add_argument('--half-perfect', type=str, default='', metavar='STATS',
                         help="like --perfect but a multiple of 50 (e.g. 450)\n"
                              "stats: " + ','.join(STATS) + " (or 'all')")
    g_goals.add_argument('--decimal', type=str, default='', metavar='STATS',
                         help="like --perfect but a multiple of 10 (e.g. 430)\n"
                              "stats: " + ','.join(STATS) + " (or 'all')")
    g_goals.add_argument('--nice', type=str, default='', metavar='STATS',
                         help="comma-separated stats forced to a 'nice' number:\n"
                              "ending in 42 or 69, or all-same-digit (444, 666)\n"
                              "stats: " + ','.join(STATS) + " (or 'all')")
    g_goals.add_argument('--match', type=str, default='', metavar='PAIRS',
                         help="comma-separated stat pairs forced to equal values,\n"
                              "e.g. 'attack=mattack,defense=mdefense'\n"
                              "(each stat's own min/max still applies)")
    g_goals.add_argument('--minimize-vocations', action='store_true',
                         help="prefer feasible builds that use fewer distinct\n"
                              "vocations (fewer vocation changes)")
    g_goals.add_argument('--bias', type=str, default='', metavar='STATS',
                         help="comma-separated stats to maximize, highest priority\n"
                              "first, e.g. 'attack,defense' maxes attack then maxes\n"
                              "defense without giving up attack. Empty (default) just\n"
                              "maximizes the (hp/st-discounted) total stat sum.\n"
                              "stats: " + ','.join(STATS) + " (or 'all' / 'combat')")
    g_goals.add_argument('--dump', type=str, default='', metavar='STATS',
                         help="comma-separated stats to minimize, highest priority\n"
                              "first (constraints still hold; ranked below --bias,\n"
                              "above the total stat sum)\n"
                              "stats: " + ','.join(STATS) + " (or 'all' / 'combat')")
    g_goals.add_argument('--equal-weights', action='store_true',
                         help="value hp/st equally with the other stats in the\n"
                              "balanced objective (by default they are discounted)")

    g_char = ap.add_argument_group(c('\U0001f4aa  character', 'bold'))
    g_char.add_argument('--weight', choices=list(WEIGHTS), default='M', metavar='CLASS',
                        type=lambda s: s.upper(),  # accept ss / Ss / sS as SS, etc.
                        help="weight class -> base stamina and regen:\n" + weights_desc +
                             "\n(default: M; case-insensitive)")
    g_char.add_argument('--pawn', action='store_true',
                        help="build for a pawn: disallow the vocations a pawn\n"
                             "cannot take (" + ', '.join(PAWN_EXCLUDED) + ")")

    g_solver = ap.add_argument_group(c('\U0001f9ee  solver', 'bold'))
    g_solver.add_argument('--solver', choices=['auto', 'ilp', 'search'], default='auto',
                          help="auto   = ILP if PuLP installed, else search (default)\n"
                               "ilp    = exact PuLP solver\n"
                               "search = stochastic hill-climb")
    g_solver.add_argument('--count', type=int, default=1, metavar='N',
                          help='number of distinct feasible builds to output (default: 1)')
    g_solver.add_argument('--seed', type=int, default=0, metavar='N',
                          help='base RNG seed; runs are reproducible per seed (default: 0)')
    g_solver.add_argument('--seeds', type=int, default=8, metavar='N',
                          help='search: random restarts to try (default: 8)')
    g_solver.add_argument('--iters', type=int, default=1500000, metavar='N',
                          help='search: iterations per seed (default: 1500000)')

    g_out = ap.add_argument_group(c('\U0001f5a5\U0000fe0f   output', 'bold'))
    g_out.add_argument('--json', action='store_true',
                       help='emit JSON instead of human-readable tables')
    g_out.add_argument('--no-color', action='store_true',
                       help='disable ANSI colors (also auto-off when not a TTY)')
    g_out.add_argument('--charset', choices=['auto', 'unicode', 'ascii'], default='auto',
                       help="box-drawing characters:\n"
                            "auto    = pick by locale (default)\n"
                            "unicode = clean borders on UTF-8 terminals\n"
                            "ascii   = 7-bit fallback")

    return ap.parse_args()

def run_search(cons, a, count=1, base_st=None, allowed=None):
    """Returns a list of feasible builds (penalty 0), distinct by their vocation
    distribution, gathered across random restarts. If none are feasible, returns
    a single-element list with the closest build found (penalty > 0)."""
    found, seen, closest = [], set(), None
    # widen the restart budget when asked for several builds
    n_seeds = max(a.seeds, count * a.seeds)
    for i in range(n_seeds):
        random.seed(a.seed + i)
        cand = search(cons, iters=a.iters, base_st=base_st, allowed=allowed)
        if closest is None or cand[0] < closest[0]:
            closest = cand
        if cand[0] == 0:
            key = (cand[1],
                   tuple(sorted(cand[2].items())),
                   tuple(sorted(cand[3].items())),
                   tuple(sorted(cand[4].items())))
            if key not in seen:
                seen.add(key)
                found.append(cand)
                if len(found) >= count:
                    break
    return found if found else [closest]

def _clean(c):
    """Drop zero-count vocations from a level-distribution dict."""
    return {k: v for k, v in c.items() if v > 0}

VOC_ORDER = ['fighter','strider','mage','warrior','ranger','sorcerer','mknight','assassin','marcher']

def _fmt_levels(counts):
    """Format a level distribution for display, e.g. 'sorcerer x100'.

    Lists vocations in canonical VOC_ORDER, skipping zeros, with counts colored;
    returns a dimmed dash when the distribution is empty.
    """
    items = [(v, counts[v]) for v in VOC_ORDER if counts.get(v, 0) > 0]
    return '  '.join(f"{c(v,'magenta')} {c(GLYPH['mul']+str(n),'bold')}" for v, n in items) or c(GLYPH['dash'], 'dim')

def print_build(idx, build, cons, rounding=None, nice=()):
    """Print one build as a colored header plus leveling-plan and final-stats tables.

    Args:
        idx: 1-based build number for the header.
        build: tuple (penalty, start, c10, c100, c200, stats).
        cons: constraints dict, used to color/annotate each final stat.
        rounding: {stat: divisor-mode-name} map (see DIVISOR_MODES); these stats'
            max bound is ignored when judging requirements, and annotated (e.g.
            "x100") in the requirement column.
        nice: iterable of stats in "nice" mode, whose max bound is likewise
            ignored (the value is annotated as "nice" in the requirement column).
    """
    p,start,c10,c100,c200,s = build
    rounding = dict(rounding or {})
    nice = set(nice)

    head = c(f"build {idx}", 'bold', 'white')
    status = c(f"{GLYPH['ok']} all requirements met", 'bold', 'green') if p == 0 \
        else c(f"{GLYPH['bad']} closest found (penalty {p:g})", 'bold', 'red')
    print(f"\n{c(GLYPH['heavy']*52,'cyan')}")
    print(f" {head}   {status}")
    print(f" start vocation: {c(start,'magenta','bold')}")
    print(f"{c(GLYPH['heavy']*52,'cyan')}")

    # leveling plan table
    a = GLYPH['arrow']
    plan = render_table(
        ["range", "levels", "vocations"],
        [
            [c(f"1{a}10",'yellow'),    c("9",'dim'),   _fmt_levels(c10)],
            [c(f"10{a}100",'yellow'),  c("90",'dim'),  _fmt_levels(c100)],
            [c(f"100{a}200",'yellow'), c("100",'dim'), _fmt_levels(c200)],
        ],
        aligns=['left', 'right', 'left'],
        title="leveling plan",
    )
    print(plan)
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
        hi_eff = None if (k in rounding or k in nice) else hi
        ok = (lo is None or s[k] >= lo) and (hi_eff is None or s[k] <= hi_eff)
        val = c(str(s[k]), 'green' if ok else 'red', 'bold')
        bound = []
        if lo is not None: bound.append(f"{GLYPH['ge']}{lo}")
        if hi_eff is not None: bound.append(f"{GLYPH['le']}{hi_eff}")
        if k in rounding: bound.append(f"{GLYPH['mul']}{DIVISOR_MODES[rounding[k]]}")
        if k in nice: bound.append("nice")
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
    print(render_table(
        ["stat", "value", "requirement"],
        rows, aligns=['left', 'right', 'left'], title="final stats",
    ))

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
    }

def main():
    """CLI entry point: parse args, run the chosen solver, and print results.

    Parses and validates the stat bounds, rounding/nice modes, match pairs,
    bias/dump priorities, weight class, and pawn restriction, dispatches to the
    ILP or search solver, and emits either a JSON document (``--json``) or
    colored tables.
    """
    a = parse_args()
    if a.no_color:
        _set_color(False)
    if a.charset != 'auto':
        _set_charset(a.charset)
    # Build per-stat (min, max) bounds. An exact value (--<stat>) pins both,
    # overriding --<stat>-min/-max. Otherwise use any explicit bounds the user
    # gave, falling back to the built-in default (unless --no-default).
    cons = {}
    exact = []
    for k in STATS:
        ev = getattr(a, k)
        if ev is not None:
            cons[k] = (ev, ev)
            exact.append(k)
            continue
        umin = getattr(a, f'{k}_min')
        umax = getattr(a, f'{k}_max')
        dlo, dhi = STAT_DEFAULTS[k]
        lo = umin if umin is not None else (None if a.no_default else dlo)
        hi = umax if umax is not None else (None if a.no_default else dhi)
        cons[k] = (lo, hi)
    count = max(1, a.count)

    def fail(msg):
        """Report an input error in the active output format and signal abort."""
        if a.json:
            print(json.dumps({"error": msg}, indent=2))
        else:
            print("error: " + msg)

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

    # Rounding/nice modes: map each flag to its mode name and build a single
    # {stat: mode} dict, erroring if a stat lands in more than one mode.
    mode_flags = [('--perfect', a.perfect, 'perfect'),
                  ('--half-perfect', a.half_perfect, 'half_perfect'),
                  ('--decimal', a.decimal, 'decimal'),
                  ('--nice', a.nice, 'nice')]
    stat_mode = {}   # {stat: mode-name}
    for flag, raw, mode in mode_flags:
        names = parse_stat_list(raw)
        bad = [s for s in names if s not in STATS]
        if bad:
            fail(f"unknown stat(s) in {flag}: {','.join(bad)}; choices: {','.join(STATS)},all")
            return
        for s in names:
            if s in exact:
                continue   # an exact value overrides any rounding/nice mode
            if s in stat_mode and stat_mode[s] != mode:
                fail(f"stat '{s}' has conflicting modes ({stat_mode[s]} and {mode})")
                return
            stat_mode[s] = mode
    # split into the divisor-based rounding map and the nice set
    rounding = {s: m for s, m in stat_mode.items() if m in DIVISOR_MODES}
    nice = [s for s, m in stat_mode.items() if m == 'nice']

    # --bias: ordered list of stats to maximize (highest priority first).
    bias = parse_stat_list(a.bias)
    bad = [s for s in bias if s not in STATS]
    if bad:
        fail(f"unknown stat(s) in --bias: {','.join(bad)}; choices: {','.join(STATS)}")
        return
    # --dump: ordered list of stats to minimize (highest priority first).
    dump = parse_stat_list(a.dump)
    bad = [s for s in dump if s not in STATS]
    if bad:
        fail(f"unknown stat(s) in --dump: {','.join(bad)}; choices: {','.join(STATS)}")
        return
    # --bias and --dump cannot target the same stat (maximize vs minimize).
    clash = set(bias) & set(dump)
    if clash:
        fail(f"--bias and --dump both target: {','.join(sorted(clash))} "
             "(cannot maximize and minimize the same stat)")
        return

    # --match: parse "a=b,c=d" into a list of (stat_a, stat_b) pairs.
    match = []
    for spec in (p.strip() for p in a.match.split(',') if p.strip()):
        if spec.count('=') != 1:
            fail(f"bad --match pair '{spec}'; expected form 'stat=stat'")
            return
        a_stat, b_stat = (STAT_ALIASES.get(x.strip(), x.strip()) for x in spec.split('='))
        unknown = [x for x in (a_stat, b_stat) if x not in STATS]
        if unknown:
            fail(f"unknown stat(s) in --match: {','.join(unknown)}; choices: {','.join(STATS)}")
            return
        if a_stat == b_stat:
            fail(f"--match pair '{spec}' matches a stat with itself")
            return
        match.append((a_stat, b_stat))

    base_st = WEIGHTS[a.weight]
    regen, regen_pct = WEIGHT_STAREGEN[a.weight]

    # --pawn restricts the advanced-vocation pool used in the 10->100 / 100->200
    # ranges by removing the vocations a pawn cannot take.
    allowed = [v for v in ALL if v not in PAWN_EXCLUDED] if a.pawn else ALL

    if not a.json:
        print(c(f"DDDA BUILD SOLVER {GLYPH['dash']} LEVEL 200", 'bold', 'cyan'))
        print(render_table(
            ["weight", "range", "base stamina", "stamina regen"],
            [[c(a.weight,'magenta','bold'), WEIGHT_RANGES[a.weight],
              c(str(base_st),'bold'), f"{regen}/s ({regen_pct})"]],
            aligns=['center','left','right','left'],
            title="character weight class",
        ))
        if a.pawn:
            print(c("pawn build: ", 'bold') +
                  c("excluding " + ', '.join(PAWN_EXCLUDED), 'yellow'))
        # map each stat to the partner stats it must match (both directions)
        match_partners = {k: [] for k in STATS}
        for a_s, b_s in match:
            match_partners[a_s].append(b_s)
            match_partners[b_s].append(a_s)

        # group matched stats into connected components (handles chains like
        # a=b,b=c). Matched stats share one value, so their effective bounds are
        # the tightest floor (max of mins) and tightest ceiling (min of maxes)
        # across the whole group.
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
                stack.extend(match_partners[cur])
            mins = [cons[m][0] for m in comp if cons[m][0] is not None]
            maxs = [cons[m][1] for m in comp if cons[m][1] is not None]
            eff = (max(mins) if mins else None, min(maxs) if maxs else None)
            for m in comp:
                comp_of[m] = eff

        crows = []
        for k in STATS:
            lo, hi = comp_of[k]   # effective (group-intersected) bounds
            is_exact = k in exact
            partners = match_partners[k]
            # single label for the stat's rounding/nice mode (mutually exclusive)
            mode = stat_mode.get(k)
            if mode in DIVISOR_MODES:
                round_label = c(f"{GLYPH['mul']}{DIVISOR_MODES[mode]}", 'green')
            elif mode == 'nice':
                round_label = c("nice", 'green')
            else:
                round_label = c(GLYPH['dash'], 'dim')
            crows.append([
                c(k,'cyan'),
                c(str(lo) if lo is not None else GLYPH['dash'], 'dim' if lo is None else None),
                c(str(hi) if hi is not None else GLYPH['dash'], 'dim' if hi is None else None),
                c('yes','green') if is_exact else c(GLYPH['dash'],'dim'),
                round_label,
                c(', '.join(partners),'green') if partners else c(GLYPH['dash'],'dim'),
            ])
        print(render_table(
            ["stat", "min", "max", "exact", "round", "match"],
            crows, aligns=['left','right','right','center','center','left'],
            title="target constraints",
        ))

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

    if method == 'ilp':
        if not a.json:
            print(c("\nsolver: ", 'dim') + c("ILP (exact)", 'green'))
        builds = solve_ilp(cons, count=count, rounding=rounding, nice=nice, match=match,
                           minimize_vocations=a.minimize_vocations, base_st=base_st,
                           allowed=allowed, bias=bias, dump=dump,
                           weights={k: 1.0 for k in STATS} if a.equal_weights else None)
        if not builds:
            if a.json:
                print(json.dumps({
                    "feasible": False,
                    "solver": method,
                    "infeasible": True,
                    "message": "no build satisfies these constraints (proven by the ILP solver)",
                    "builds": [],
                }, indent=2))
            else:
                print(c(f"\n{GLYPH['bad']} INFEASIBLE", 'bold', 'red') +
                      ": no build satisfies these constraints (proven by the ILP solver).")
            return
    else:
        if not a.json:
            ilp_only = [('--perfect', a.perfect), ('--half-perfect', a.half_perfect),
                        ('--decimal', a.decimal), ('--nice', a.nice), ('--match', a.match),
                        ('--minimize-vocations', a.minimize_vocations),
                        ('--bias', a.bias), ('--dump', a.dump)]
            for flag, val in ilp_only:
                if val:
                    print(c(f"\nnote: {flag} is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            print(c("\nsolver: ", 'dim') + c("search (stochastic hill-climb)", 'yellow'))
        builds = run_search(cons, a, count=count, base_st=base_st, allowed=allowed)

    if a.json:
        doc = {
            "weight": {
                "class": a.weight,
                "range": WEIGHT_RANGES[a.weight],
                "base_stamina": base_st,
                "stamina_regen_per_sec": regen,
                "stamina_regen_pct": regen_pct,
            },
            "constraints": {k: {"min": cons[k][0], "max": cons[k][1],
                                "exact": k in exact,
                                "perfect": stat_mode.get(k) == 'perfect',
                                "half_perfect": stat_mode.get(k) == 'half_perfect',
                                "decimal": stat_mode.get(k) == 'decimal',
                                "nice": stat_mode.get(k) == 'nice'} for k in STATS},
            "match": [[a_s, b_s] for a_s, b_s in match],
            "pawn": a.pawn,
            "excluded_vocations": PAWN_EXCLUDED if a.pawn else [],
            "bias": bias,
            "dump": dump,
            "solver": method,
            "requested": count,
            "found": len(builds),
            "builds": [build_to_dict(b) for b in builds],
        }
        print(json.dumps(doc, indent=2))
        return

    print(c(f"\nfound {len(builds)} build(s)", 'bold') + (c(f" (requested {count})", 'dim') if count > 1 else "") + ":")
    for i, b in enumerate(builds, 1):
        print_build(i, b, cons, rounding, nice)
    if len(builds) < count:
        print(c(f"\n(only {len(builds)} distinct feasible build(s) could be produced for these constraints)", 'yellow'))

if __name__ == '__main__':
    main()
