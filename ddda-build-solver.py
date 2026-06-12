#!/usr/bin/env python3
"""ddda-build-solver: Dragon's Dogma: Dark Arisen level-200 build solver.

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
BASIC = list(basic.keys())
ALL = list(basic.keys()) + list(adv.keys())
# Advanced vocations disabled by --pawn (vocations a pawn cannot take).
PAWN_EXCLUDED = ['mknight', 'marcher', 'assassin']

# Character weight class sets initial stamina. The data above assumes M (540).
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

def stats_of(start, c10, c100, c200, init_st=None):
    """Compute final stats for a build.

    Args:
        start: starting basic vocation, providing the level-1 base stats.
        c10: dict {vocation: level-count} for the 1->10 range (sums to 9).
        c100: dict {vocation: level-count} for the 10->100 range (sums to 90).
        c200: dict {vocation: level-count} for the 100->200 range (sums to 100).
        init_st: optional override for starting stamina (weight class); when
            None the data default (M = 540) baked into ``start`` is used.

    Returns:
        dict mapping each stat in STATS to its final value.
    """
    s = dict(basic[start]['init'])
    if init_st is not None:
        s['st'] = init_st   # weight class overrides the data's default (M=540)
    for voc,n in c10.items():
        g = growth(voc,'to10')
        for k in STATS: s[k]+=g[k]*n
    for voc,n in c100.items():
        g = growth(voc,'to100')
        for k in STATS: s[k]+=g[k]*n
    for voc,n in c200.items():
        g = growth(voc,'to200')
        for k in STATS: s[k]+=g[k]*n
    return s

def hard_penalty(s, cons):
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

def penalty(s, cons):
    """Objective for the search solver; alias of ``hard_penalty`` (0 = feasible)."""
    return hard_penalty(s, cons)

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

def search(cons, iters=1500000, init_st=None, allowed=None):
    """Stochastic hill-climb for a feasible build (fallback when PuLP is absent).

    Performs random restarts, each starting from a random vocation distribution
    and repeatedly accepting single-level moves (and occasional start-vocation
    swaps) that do not worsen the penalty.

    Args:
        cons: dict {stat: (min, max)} target constraints.
        iters: total moves to attempt, split evenly across restarts.
        init_st: optional starting-stamina override (weight class).
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
        cur_p = penalty(stats_of(start,c10,c100,c200,init_st), cons)
        for it in range(iters//60):
            which = random.random()
            if which < 0.1:
                nstart = random.choice(BASIC); nc10,nc100,nc200=c10,c100,c200
                np_ = penalty(stats_of(nstart,nc10,nc100,nc200,init_st), cons)
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
            np_ = penalty(stats_of(nstart,nc10,nc100,nc200,init_st), cons)
            if np_<=cur_p:
                c10,c100,c200=nc10,nc100,nc200; cur_p=np_
        s = stats_of(start,c10,c100,c200,init_st)
        cand = (cur_p, start, c10, c100, c200, s)
        if best is None or cand[0]<best[0]:
            best = cand
    return best

def is_neat(n):
    """Return True if ``n`` is a 'neat' number.

    Neat numbers are: exactly 666; anything ending in 42 or 69; a repdigit (all
    digits identical, e.g. 444, 7777); or a "perfect" number, i.e. a multiple of
    100 (matching the ``--perfect`` definition).
    """
    if n == 666: return True
    if n % 100 == 42: return True
    if n % 100 == 69: return True
    if len(set(str(n))) == 1: return True   # repdigit (e.g. 111, 4444)
    if n != 0 and n % 100 == 0: return True  # perfect: multiple of 100
    return False

def neat_values(lo, hi):
    """List the neat numbers in the inclusive range [lo, hi] (sorted ascending)."""
    return [n for n in range(max(0, lo), hi + 1) if is_neat(n)]

def _stat_upper_bound(k, base, adv_pool=ALL):
    """Tight upper bound on stat ``k`` for a build starting from ``base``.

    Equals the base value plus the maximum possible per-level gain in each
    range; used only to bound the neat-value enumeration in the ILP. ``adv_pool``
    restricts the vocations available in the 10->100 and 100->200 ranges.
    """
    m10  = max(growth(v, 'to10')[k]  for v in BASIC)
    m100 = max(growth(v, 'to100')[k] for v in adv_pool)
    m200 = max(growth(v, 'to200')[k] for v in adv_pool)
    return base[k] + 9 * m10 + 90 * m100 + 100 * m200

def solve_ilp(cons, count=1, perfect=(), neat=(), match=(), minimize_vocations=False,
              init_st=None, allowed=None):
    """Exact integer-linear solver. Returns a list of distinct feasible builds,
    each a tuple (penalty, start, c10, c100, c200, stats); penalty is always 0
    (constraints are modeled as hard). Returns [] if infeasible. Up to `count`
    builds are returned, gathered across the three start vocations; within a
    start, distinct solutions are enumerated with no-good cuts.

    `perfect` is a set of stat names that must each be an exact multiple of 100.
    For a perfect stat the max bound is dropped and the min (if any) is kept as a
    floor; the value is forced to 100*k via a fresh integer k.

    `neat` is a set of stat names that must each be a "neat" number (see
    ``is_neat``). Like perfect, the max bound is dropped and the min kept as a
    floor; the value is forced into the enumerated neat set via binary selectors.

    `match` is an iterable of (stat_a, stat_b) pairs whose final values are
    constrained to be equal. Each stat's own min/max bounds still apply.

    `minimize_vocations`: when True, the dominant objective term minimizes the
    number of distinct vocations that receive any level-ups, so feasible builds
    that require fewer vocation changes are preferred.

    `allowed`: optional iterable restricting which vocations may be used in the
    10->100 and 100->200 ranges (defaults to all). Basic vocations are always
    permitted in the 1->10 range.
    """
    perfect = set(perfect)
    neat = set(neat)
    adv_pool = list(allowed) if allowed is not None else ALL
    results = []
    # The start vocation only shifts the constant base stats, so solve one ILP
    # family per basic start.
    for start in BASIC:
        if len(results) >= count:
            break
        base = dict(basic[start]['init'])
        if init_st is not None:
            base['st'] = init_st   # weight class overrides the data's default (M=540)

        prob = pulp.LpProblem("build", pulp.LpMinimize)
        # integer count of level-ups taken in each (vocation, tier), with upper
        # bounds = the block size (used as big-M for the no-good cuts below).
        x10  = {v: pulp.LpVariable(f"x10_{v}",  lowBound=0, upBound=9,   cat="Integer") for v in BASIC}
        x100 = {v: pulp.LpVariable(f"x100_{v}", lowBound=0, upBound=90,  cat="Integer") for v in adv_pool}
        x200 = {v: pulp.LpVariable(f"x200_{v}", lowBound=0, upBound=100, cat="Integer") for v in adv_pool}
        allvars = [(x10, BASIC, 9), (x100, adv_pool, 90), (x200, adv_pool, 100)]

        # block sizes: 1->10 = 9 levels, 10->100 = 90, 100->200 = 100
        prob += pulp.lpSum(x10.values())  == 9
        prob += pulp.lpSum(x100.values()) == 90
        prob += pulp.lpSum(x200.values()) == 100

        # each stat's final value as a linear expression
        exprs = {}
        for k in STATS:
            expr = base[k] \
                + pulp.lpSum(growth(v,'to10')[k]  * x10[v]  for v in BASIC) \
                + pulp.lpSum(growth(v,'to100')[k] * x100[v] for v in adv_pool) \
                + pulp.lpSum(growth(v,'to200')[k] * x200[v] for v in adv_pool)
            exprs[k] = expr
            lo, hi = cons[k]
            if k in perfect:
                # perfect mode: value == 100*mult, min kept as floor, max dropped
                mult = pulp.LpVariable(f"perf_{k}_{start}", lowBound=0, cat="Integer")
                prob += expr == 100 * mult
                if lo is not None: prob += expr >= lo
            elif k in neat:
                # neat mode: value must be one of the enumerated neat numbers in
                # [floor, reachable-max]. Pick exactly one via binary selectors.
                floor = lo if lo is not None else 0
                ub = _stat_upper_bound(k, base, adv_pool)
                choices = neat_values(floor, ub)
                if not choices:
                    # no neat value is reachable for this stat -> infeasible start
                    prob += expr <= -1   # trivially unsatisfiable
                else:
                    sel = {nv: pulp.LpVariable(f"neat_{k}_{nv}_{start}", cat="Binary") for nv in choices}
                    prob += pulp.lpSum(sel.values()) == 1
                    prob += expr == pulp.lpSum(nv * sel[nv] for nv in choices)
                if lo is not None: prob += expr >= lo
            else:
                if lo is not None: prob += expr >= lo
                if hi is not None: prob += expr <= hi

        # match mode: force paired stats to share the same final value.
        for a_stat, b_stat in match:
            prob += exprs[a_stat] == exprs[b_stat]

        # penalty is reported against constraints as actually enforced: perfect
        # and neat stats keep only their floor, so their dropped max isn't counted.
        relaxed = perfect | neat
        eval_cons = {k: ((cons[k][0], None) if k in relaxed else cons[k]) for k in STATS}

        # Objective:
        #  - 1->10 range: encourage mage levels (prefer mage there when feasible).
        #  - 10->100 range: discourage mage levels, encourage sorcerer levels.
        # Among equally-feasible builds the solver leans toward these choices.
        # (Was pure feasibility: prob += 0.)
        # Note: fighter start vocation is preferred separately, by trying starts
        # in BASIC order (fighter first) and stopping once `count` builds are found.
        objective = -x10['mage'] + x100['mage'] - x100['sorcerer']

        if minimize_vocations:
            # A vocation is "used" if it receives any level in any tier. Bind a
            # binary used[v] >= (its level share) / blocksize, then minimize the
            # total count of used vocations as the dominant objective term.
            tiers = [(x10, BASIC, 9), (x100, ALL, 90), (x200, ALL, 100)]
            used = {v: pulp.LpVariable(f"used_{v}_{start}", cat="Binary") for v in adv_pool}
            for xs, vocs, U in tiers:
                for v in vocs:
                    # if x[v] > 0 then used[v] must be 1 (x[v] <= U * used[v])
                    prob += xs[v] <= U * used[v]
            # Weight high enough to dominate the soft mage/sorcerer preferences,
            # whose combined magnitude is bounded by the block sizes (<= ~180).
            objective = 1000 * pulp.lpSum(used.values()) + objective

        prob += objective

        cut_id = 0
        while len(results) < count:
            prob.solve(pulp.PULP_CBC_CMD(msg=0))
            if pulp.LpStatus[prob.status] != "Optimal":
                break  # no more distinct builds for this start
            c10  = {v: int(round(x10[v].value()))  for v in BASIC}
            c100 = {v: int(round(x100[v].value())) for v in adv_pool}
            c200 = {v: int(round(x200[v].value())) for v in adv_pool}
            s = stats_of(start, c10, c100, c200, init_st=init_st)
            results.append((penalty(s, eval_cons), start, c10, c100, c200, s))

            # No-good cut: force the next solution to differ from this one in at
            # least one variable. For each var x_i with value v_i, a binary g_i
            # (=> x_i >= v_i+1) and l_i (=> x_i <= v_i-1); require sum(g+l) >= 1.
            inds = []
            for xs, vocs, U in allvars:
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

    return results[:count]

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
        description=c("\n  \U0001f409  ddda-build-solver \U00002014 Dragon's Dogma level-200 build solver\n",
                      'bold', 'cyan') +
                    "  Find a build whose final stats meet your targets. Each stat takes an\n"
                    "  optional min and/or max (omit one to leave it unbounded), or an exact\n"
                    "  value. The ILP solver also supports perfect / neat / match goals.",
        epilog=c("\nexamples:\n", 'bold', 'yellow') +
               "  # minimum HP and stamina, everything else default\n"
               "  ddda-build-solver.py --hp-min 3600 --st-min 4000\n\n"
               "  # pin attack to an exact value, output 3 distinct builds\n"
               "  ddda-build-solver.py --attack 550 --count 3\n\n"
               "  # keep physical and magick stats equal, fewest vocation changes\n"
               "  ddda-build-solver.py --match attack=mattack,defense=mdefense --minimize-vocations\n\n"
               "  # heavy character, neat HP, machine-readable output\n"
               "  ddda-build-solver.py --weight LL --neat hp --json\n")

    # defaults reproduce the originally requested build
    defaults = {
        'hp':       (3500, None),
        'st':       (3500, None),
        'attack':   (500,  None),
        'defense':  (300,  None),
        'mattack':  (500,  None),
        'mdefense': (300,  None),
    }

    g_stats = ap.add_argument_group(c('\U0001f3af  stat targets', 'bold'),
        "Per stat: --STAT pins an exact value; --STAT-min / --STAT-max set bounds.\n"
        "An exact value overrides that stat's min/max.")
    for stat,(lo,hi) in defaults.items():
        g_stats.add_argument(f'--{stat}', type=int, default=None, metavar='N',
                             help=f'exact {stat} (overrides --{stat}-min/--{stat}-max)')
        g_stats.add_argument(f'--{stat}-min', type=int, default=lo, metavar='N',
                             help=f'minimum {stat} (default: {lo})')
        g_stats.add_argument(f'--{stat}-max', type=int, default=hi, metavar='N',
                             help=f'maximum {stat} (default: {hi if hi is not None else "none"})')

    g_goals = ap.add_argument_group(c('\U00002728  ILP-only goals', 'bold'),
        "Extra constraints honored only by the exact (ILP) solver.")
    g_goals.add_argument('--perfect', type=str, default='', metavar='STATS',
                         help="comma-separated stats forced to a multiple of 100\n"
                              "(max bound dropped, min kept as a floor)\n"
                              "stats: " + ','.join(STATS))
    g_goals.add_argument('--neat', type=str, default='', metavar='STATS',
                         help="comma-separated stats forced to a 'neat' number:\n"
                              "666, ending in 42 or 69, all-same-digit (444),\n"
                              "or a multiple of 100\n"
                              "stats: " + ','.join(STATS))
    g_goals.add_argument('--match', type=str, default='', metavar='PAIRS',
                         help="comma-separated stat pairs forced to equal values,\n"
                              "e.g. 'attack=mattack,defense=mdefense'\n"
                              "(each stat's own min/max still applies)")
    g_goals.add_argument('--minimize-vocations', action='store_true',
                         help="prefer feasible builds that use fewer distinct\n"
                              "vocations (fewer vocation changes)")

    g_char = ap.add_argument_group(c('\U0001f4aa  character', 'bold'))
    g_char.add_argument('--weight', choices=list(WEIGHTS), default='M', metavar='CLASS',
                        help="weight class -> initial stamina and regen:\n" + weights_desc +
                             "\n(default: M)")
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

def run_search(cons, a, count=1, init_st=None, allowed=None):
    """Returns a list of feasible builds (penalty 0), distinct by their vocation
    distribution, gathered across random restarts. If none are feasible, returns
    a single-element list with the closest build found (penalty > 0)."""
    found, seen, closest = [], set(), None
    # widen the restart budget when asked for several builds
    n_seeds = max(a.seeds, count * a.seeds)
    for i in range(n_seeds):
        random.seed(a.seed + i)
        cand = search(cons, iters=a.iters, init_st=init_st, allowed=allowed)
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

def print_build(idx, build, cons, perfect, neat=()):
    """Print one build as a colored header plus leveling-plan and final-stats tables.

    Args:
        idx: 1-based build number for the header.
        build: tuple (penalty, start, c10, c100, c200, stats).
        cons: constraints dict, used to color/annotate each final stat.
        perfect: iterable of stats in "perfect" (multiple-of-100) mode, whose max
            bound is ignored when judging whether the value meets requirements.
        neat: iterable of stats in "neat" mode, whose max bound is likewise
            ignored (the value is annotated as "neat" in the requirement column).
    """
    p,start,c10,c100,c200,s = build
    perfect = set(perfect)
    neat = set(neat)

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

    # final stats table, each value colored by whether it satisfies its bound
    rows = []
    for k in STATS:
        lo, hi = cons[k]
        hi_eff = None if (k in perfect or k in neat) else hi
        ok = (lo is None or s[k] >= lo) and (hi_eff is None or s[k] <= hi_eff)
        val = c(str(s[k]), 'green' if ok else 'red', 'bold')
        bound = []
        if lo is not None: bound.append(f"{GLYPH['ge']}{lo}")
        if hi_eff is not None: bound.append(f"{GLYPH['le']}{hi_eff}")
        if k in perfect: bound.append(f"{GLYPH['mul']}100")
        if k in neat: bound.append("neat")
        rows.append([c(k,'cyan'), val, c(' '.join(bound) or GLYPH['dash'], 'dim')])
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
        "final_stats": s,
    }

def main():
    """CLI entry point: parse args, run the chosen solver, and print results.

    Reads constraints, weight class, and the perfect-stat list from the command
    line, dispatches to the ILP or search solver, and emits either a JSON
    document (``--json``) or colored tables.
    """
    a = parse_args()
    if a.no_color:
        _set_color(False)
    if a.charset != 'auto':
        _set_charset(a.charset)
    # An exact value (--<stat>) pins both bounds, overriding --<stat>-min/-max.
    cons = {}
    exact = []
    for k in STATS:
        ev = getattr(a, k)
        if ev is not None:
            cons[k] = (ev, ev)
            exact.append(k)
        else:
            cons[k] = (getattr(a, f'{k}_min'), getattr(a, f'{k}_max'))
    count = max(1, a.count)

    def fail(msg):
        """Report an input error in the active output format and signal abort."""
        if a.json:
            print(json.dumps({"error": msg}, indent=2))
        else:
            print("error: " + msg)

    perfect = [s.strip() for s in a.perfect.split(',') if s.strip()]
    neat = [s.strip() for s in a.neat.split(',') if s.strip()]
    for flag, names in (('--perfect', perfect), ('--neat', neat)):
        bad = [s for s in names if s not in STATS]
        if bad:
            fail(f"unknown stat(s) in {flag}: {','.join(bad)}; choices: {','.join(STATS)}")
            return
    both = set(perfect) & set(neat)
    if both:
        fail(f"stat(s) in both --perfect and --neat: {','.join(sorted(both))}")
        return

    # --match: parse "a=b,c=d" into a list of (stat_a, stat_b) pairs.
    match = []
    for spec in (p.strip() for p in a.match.split(',') if p.strip()):
        if spec.count('=') != 1:
            fail(f"bad --match pair '{spec}'; expected form 'stat=stat'")
            return
        a_stat, b_stat = (x.strip() for x in spec.split('='))
        unknown = [x for x in (a_stat, b_stat) if x not in STATS]
        if unknown:
            fail(f"unknown stat(s) in --match: {','.join(unknown)}; choices: {','.join(STATS)}")
            return
        if a_stat == b_stat:
            fail(f"--match pair '{spec}' matches a stat with itself")
            return
        match.append((a_stat, b_stat))

    init_st = WEIGHTS[a.weight]
    regen, regen_pct = WEIGHT_STAREGEN[a.weight]

    # --pawn restricts the advanced-vocation pool used in the 10->100 / 100->200
    # ranges by removing the vocations a pawn cannot take.
    allowed = [v for v in ALL if v not in PAWN_EXCLUDED] if a.pawn else ALL

    if not a.json:
        print(c(f"DDDA BUILD SOLVER {GLYPH['dash']} LEVEL 200", 'bold', 'cyan'))
        print(render_table(
            ["weight", "range", "init stamina", "stamina regen"],
            [[c(a.weight,'magenta','bold'), WEIGHT_RANGES[a.weight],
              c(str(init_st),'bold'), f"{regen}/s ({regen_pct})"]],
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
            crows.append([
                c(k,'cyan'),
                c(str(lo) if lo is not None else GLYPH['dash'], 'dim' if lo is None else None),
                c(str(hi) if hi is not None else GLYPH['dash'], 'dim' if hi is None else None),
                c('yes','green') if is_exact else c(GLYPH['dash'],'dim'),
                c('yes','green') if k in perfect else c(GLYPH['dash'],'dim'),
                c('yes','green') if k in neat else c(GLYPH['dash'],'dim'),
                c(', '.join(partners),'green') if partners else c(GLYPH['dash'],'dim'),
            ])
        print(render_table(
            ["stat", "min", "max", "exact", "perfect", "neat", "match"],
            crows, aligns=['left','right','right','center','center','center','left'],
            title="target constraints",
        ))

    method = a.solver
    if method == 'auto':
        method = 'ilp' if HAVE_PULP else 'search'
    if method == 'ilp' and not HAVE_PULP:
        if not a.json:
            print("\nPuLP not installed; falling back to stochastic search.")
        method = 'search'

    if method == 'ilp':
        if not a.json:
            print(c("\nsolver: ", 'dim') + c("ILP (exact)", 'green'))
        builds = solve_ilp(cons, count=count, perfect=perfect, neat=neat, match=match,
                           minimize_vocations=a.minimize_vocations, init_st=init_st,
                           allowed=allowed)
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
            if perfect:
                print(c("\nnote: --perfect is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            if neat:
                print(c("\nnote: --neat is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            if match:
                print(c("\nnote: --match is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            if a.minimize_vocations:
                print(c("\nnote: --minimize-vocations is only supported by the ILP solver; ignoring it for search.", 'yellow'))
            print(c("\nsolver: ", 'dim') + c("search (stochastic hill-climb)", 'yellow'))
        builds = run_search(cons, a, count=count, init_st=init_st, allowed=allowed)

    if a.json:
        doc = {
            "weight": {
                "class": a.weight,
                "range": WEIGHT_RANGES[a.weight],
                "initial_stamina": init_st,
                "stamina_regen_per_sec": regen,
                "stamina_regen_pct": regen_pct,
            },
            "constraints": {k: {"min": cons[k][0], "max": cons[k][1],
                                "exact": k in exact, "perfect": k in perfect,
                                "neat": k in neat} for k in STATS},
            "match": [[a_s, b_s] for a_s, b_s in match],
            "pawn": a.pawn,
            "excluded_vocations": PAWN_EXCLUDED if a.pawn else [],
            "solver": method,
            "requested": count,
            "found": len(builds),
            "builds": [build_to_dict(b) for b in builds],
        }
        print(json.dumps(doc, indent=2))
        return

    print(c(f"\nfound {len(builds)} build(s)", 'bold') + (c(f" (requested {count})", 'dim') if count > 1 else "") + ":")
    for i, b in enumerate(builds, 1):
        print_build(i, b, cons, perfect, neat)
    if len(builds) < count:
        print(c(f"\n(only {len(builds)} distinct feasible build(s) could be produced for these constraints)", 'yellow'))

if __name__ == '__main__':
    main()
