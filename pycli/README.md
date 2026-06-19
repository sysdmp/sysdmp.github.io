# ddda-build-solver

A command-line solver for **Dragon's Dogma™: Dark Arisen** character builds. Tell it
the final stats you want at level 200 — minimums, maximums, exact values, or fancier
goals — and it computes which vocation to level in, and for how long, to get there.

It uses an exact integer-linear-programming (ILP) solver by default, so when a build
exists it finds one and proves it; when none exists, it tells you so definitively.

```console
$ ddda-build-solver.py --hp-min 3600 --st-min 4000 --match attack=mattack
```

---

## Table of contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Output](#output)
- [Options reference](#options-reference)
  - [Stat targets](#stat-targets)
  - [ILP-only goals](#ilp-only-goals)
  - [Character](#character)
  - [Solver](#solver)
  - [Output control](#output-control)
- [Examples](#examples)
- [Notes & caveats](#notes--caveats)

---

## How it works

In Dragon's Dogma™, your six core stats grow automatically each level, and how much
they grow depends on the **vocation** you are leveling as. The game has three growth
ranges with different per-level gains:

| Range       | Levels | Who can level here          |
|-------------|--------|-----------------------------|
| `1 → 10`    | 9      | basic vocations only        |
| `10 → 100`  | 90     | any of the 9 vocations       |
| `100 → 200` | 100    | any of the 9 vocations       |

- **Basic vocations** (available from level 1): `fighter`, `strider`, `mage`. Your
  starting basic vocation also sets your level-1 base stats.
- **Advanced vocations** (unlocked later): `warrior`, `ranger`, `sorcerer`,
  `mknight` (Mystic Knight), `assassin`, `marcher` (Magick Archer).

The six stats tracked are **hp**, **st** (stamina), **attack**, **defense**,
**mattack** (magick attack), and **mdefense** (magick defense).

Because growth is **linear**, a build is fully described by *how many levels you spend
in each (vocation, range)* plus your starting vocation. Final stats are the starting
base plus the summed per-level gains.
The solver picks the level allocation that satisfies your constraints. With the
default ILP solver this is an exact optimization; a stochastic fallback (`search`) is
available when the ILP library is not installed.

## Installation

The project uses [uv](https://docs.astral.sh/uv/). The only runtime dependency is
[PuLP](https://coin-or.github.io/pulp/) (for the exact solver), declared in
`pyproject.toml`.

```console
$ uv run ddda-build-solver.py --help
```

`uv run` creates the virtual environment and installs dependencies automatically on
first use. If you prefer to run with a plain `python3`, install PuLP yourself
(`pip install pulp`); without it, the tool falls back to the `search` solver.

## Quick start

Run with no arguments to solve for the built-in default targets (hp ≥ 3500,
defense/mdefense ≥ 300; st/attack/mattack unconstrained):

```console
$ uv run ddda-build-solver.py
```

Tighten or relax any stat with `--<stat>-min` / `--<stat>-max`, pin one exactly with
`--<stat>`, and layer on the [ILP-only goals](#ilp-only-goals) as needed.

## Output

By default the tool prints colored ASCII/Unicode tables: the target constraints (with
a single `round` column showing each stat's rounding/nice mode), and for each build a
**leveling plan** (start vocation, which vocation to level in each range, the total
**vocation switches** the plan requires, and a warning if it changes vocation before
level 10) and the resulting **final stats** (green if a
stat meets its requirement, red if not). The final-stats table ends with the summary
rows **combat** (attack+mattack+defense+mdefense), **vitals** (hp+st), and **total**
(all six), followed by the **weight class** (class, base stamina, stamina regen, max encumbrance).
Each build also prints an **owoc planner** link — a shareable URL that opens the build,
pre-filled, in the [owoc.github.io](https://owoc.github.io) online planner.

```text
solver: ILP (exact)

found 1 build(s):

====================================================
 build 1   [OK] all requirements met
====================================================
               leveling plan
+----------+--------+-----------------------+
| range    | levels | vocations             |
+----------+--------+-----------------------+
| start    |      - | fighter               |
| 1->10    |      9 | mage x9               |
| 10->100  |     90 | fighter x90           |
| 100->200 |    100 | mage x62  warrior x38 |
+----------+--------+-----------------------+
 ⚠  changing vocation before level 10:
    to do it, restart the game in Hard Mode — this resets save
    progress, but the character keeps its levels and items.
 vocation switches: 3 (4 leveling blocks across the 3 ranges)
                      final stats
+--------------+-------+---------------------------------+
| stat         | value | details                         |
+--------------+-------+---------------------------------+
| hp           |  4788 | >=3500                          |
| st           |  3260 | -                               |
| attack       |   534 | -                               |
| defense      |   543 | >=300                           |
| mattack      |   400 | -                               |
| mdefense     |   301 | >=300                           |
| ---          |   --- | ---                             |
| combat       |  1778 | attack+mattack+defense+mdefense |
| vitals       |  8048 | hp + st                         |
| total        |  9826 | all stats                       |
| ---          |   --- | ---                             |
| weight class |     M | 70-89kg                         |
| base st      |   540 | base stamina                    |
| st regen     |  42/s | 100% of M                       |
| encumbrance  |  65kg | base maximum encumbrance        |
+--------------+-------+---------------------------------+
 owoc planner: https://owoc.github.io/#af...
```

Pass `--json` for machine-readable output instead (see [Output control](#output-control)).

## Options reference

Run `ddda-build-solver.py --help` for the full, grouped help text. Summary below.

### Stat targets

For each of the six stats (`hp`, `st`, `attack`, `defense`, `mattack`, `mdefense`):

| Flag             | Meaning                                                        |
|------------------|----------------------------------------------------------------|
| `--<stat>`       | Pin the stat to an **exact** value (overrides that stat's min/max). |
| `--<stat>-min N` | Lower bound (floor).                                           |
| `--<stat>-max N` | Upper bound (ceiling).                                         |

Omit a bound to leave it unconstrained. Defaults: `hp` min 3500, `defense`/`mdefense`
min 300; `st`/`attack`/`mattack` unconstrained, no maximums.

`--no-default` ignores the built-in default minimums entirely — only the constraints
you pass explicitly apply.

### ILP-only goals

These are honored only by the exact (`ilp`) solver; the `search` solver ignores them
with a warning.

**Rounding** — force stats to a "round" value. This drops the stat's max bound and keeps
its min as a floor. A stat may be either divisor-rounded or `nice`, not both, and an exact
`--<stat>` value overrides either.

| Flag             | Forces each listed stat to…                                                  |
|------------------|------------------------------------------------------------------------------|
| `--divisor SPEC` | a **multiple of a divisor**. A bare number applies to every stat (`--divisor 100` → multiples of 100; 50 = half-perfect, 10 = round decimal). Or give per-stat `stat=N` segments: `--divisor attack=10,mattack=20`. Group keywords work (`--divisor combat=50`), and later segments override earlier ones. |
| `--nice STATS`   | a **"nice" number**: a repdigit of 3+ identical digits (`444`, `666`, `7777`). |

**Other goals:**

| Flag                    | Meaning                                                                                          |
|-------------------------|--------------------------------------------------------------------------------------------------|
| `--match PAIRS`         | Comma-separated stat pairs tied together. `a=b` forces **equal** final values; `a~b` lets them differ by at most **10** points for combat pairs, or **100** for the `hp~st` pair (e.g. `attack~mattack` might give 490 / 500). Mix freely: `attack=mattack,defense~mdefense`. The keyword `all` expands to the three exact pairings `attack=mattack,defense=mdefense,hp=st`. Each stat's own min/max still applies. |
| `--bias STATS`          | Comma-separated **priority tiers** of stats to softly favor — the first tier favored most, each later tier less. Positively-biased stats are guaranteed to grow (an equal-share floor proportional to their tier), then the weighted total maximizes within that. Group stats into one tier (equal weight) with `=`: e.g. `attack=mattack,mdefense` favors attack and mattack equally (tier 1) and mdefense too but less (tier 2). Prefix a tier with `-` to **reduce** a stat's weight instead — pass it via the `=` form so argparse keeps the dash (`--bias=-mattack`) or after a comma (`attack,-mattack`); positive and negative tiers are independent and their order doesn't matter. A soft preference; use `--maximize`/`--minimize` for hard guarantees. |
| `--maximize STATS`      | Comma-separated stats to **hard-maximize**, highest priority first (lexicographic): `attack,defense` maxes attack, then maxes defense without giving up attack. Sits above the total-stat objective. |
| `--minimize STATS`      | Comma-separated stats to **hard-minimize**, highest priority first. Ranked below `--maximize`, above the total-stat objective. |
| `--minimize-vocations`  | Among feasible builds, prefer ones that use **fewer distinct vocations** (fewer vocation changes). Dominates the maximize/minimize/total objective. |
| `--equal-weights`       | Value **hp/st equally** with the other stats in the balanced objective (by default they're discounted — see below). |

**Group keywords** — anywhere a `STATS` list is accepted (`--divisor`, `--nice`, `--bias`,
`--maximize`, `--minimize`), two shorthands expand to multiple stats:

- `all` → every stat (`hp,st,attack,defense,mattack,mdefense`).
- `combat` → the four combat stats (`attack,defense,mattack,mdefense`).

**Balanced objective (no `--bias`):** by default the solver maximizes a *weighted*
total of the final stats, with **hp and st discounted** (weight 0.1 vs 1.0 for the
combat stats). hp/st have large raw values and grow cheaply, so this stops the
balanced build from piling level-ups into them at the expense of combat stats. Pass
`--equal-weights` to value every stat equally instead.

### Character

| Flag             | Meaning                                                                 |
|------------------|-------------------------------------------------------------------------|
| `--weight CLASS` | Weight class, which sets base stamina, stamina-regen rate, and max encumbrance. One of `SS`, `S`, `M`, `L`, `LL` (default `M`); case-insensitive. |
| `--avoid VOCS`   | Comma-separated vocations to drop from consideration entirely (never leveled in any range, and excluded as a start vocation). |
| `--pawn`         | Build for a pawn: excludes `mknight,marcher,assassin` (as `--avoid`), **and** enforces the pawn 1→10 rule (see below). |
| `--no-early-switcheroo` | Forbid changing vocation before level 10: all nine 1→10 levels stay in the start vocation (no Hard Mode restart trick). Honored by both solvers. |

| Class | Body weight     | Base stamina | Stamina regen | Max encumbrance |
|-------|-----------------|--------------|---------------|-----------------|
| SS    | under 50 kg     | 500          | 53/s (125%)   | 40 kg           |
| S     | 50–69 kg        | 520          | 48/s (115%)   | 50 kg           |
| M     | 70–89 kg        | 540          | 42/s (100%)   | 65 kg           |
| L     | 90–109 kg       | 560          | 38/s (90%)    | 75 kg           |
| LL    | 110 kg and over | 580          | 31/s (75%)    | 100 kg          |

Stamina regen and max encumbrance are informational (they do not affect the solve).

Unlike the [ILP-only goals](#ilp-only-goals), `--avoid` (and its `--pawn` alias) is
honored by **both** solvers. It removes the named vocations from every range and from
the start-vocation choices — useful for planning a pawn (whose pool is `mknight,
marcher, assassin` smaller than the Arisen's), or for excluding any vocation you don't
want to play. Avoiding all three basic vocations is rejected (one must remain as a
start), and if your targets genuinely require an avoided vocation the result is
reported as infeasible.

`--pawn` additionally enforces the **pawn 1→10 rule**: a pawn cannot change vocation at
level 1, so its forced first level-up is taken in its starting vocation. At least one of
the nine 1→10 levels must therefore be spent in the start vocation, leaving up to eight
for a basic-vocation switch. (Example: starting as a fighter, you cannot take all nine
1→10 levels as a mage — you get fighter level 1, one forced fighter level-up, then eight
mage levels still fit.) The Arisen has no such restriction and can switch vocation at
level 1 (via the Hard Mode restart trick) for all nine pre-10 levels. Both solvers honor
this rule.

### Solver

| Flag         | Meaning                                                                            |
|--------------|------------------------------------------------------------------------------------|
| `--solver`   | `auto` (ILP if PuLP installed, else search — default), `ilp`, or `search`.         |
| `--count N`  | Number of **distinct** feasible builds to output (default 1).                      |
| `--seed N`   | Base RNG seed; runs are reproducible per seed (default 0). Affects `search` only.  |
| `--seeds N`  | `search`: number of random restarts (default 8).                                   |
| `--iters N`  | `search`: iterations per seed (default 1,500,000).                                 |
| `--posixly-correct` | `ilp`: remove the per-solve CBC time cap, letting it grind to a proven-optimal solution however long that takes. |

The ILP solver is exact and fast; it evaluates every allowed start vocation and picks
the one whose build best satisfies the objective (ties fall back to `fighter` /
`strider` / `mage` order), enumerating distinct builds via no-good cuts when
`--count > 1`. The `search` solver is a stochastic hill-climb used only as a fallback.

By default each CBC solve is capped at a few seconds: some flag combinations (e.g.
`--divisor 100` with a continuous `--bias`) leave CBC holding the optimum but unable to
*prove* it quickly, so it returns the best feasible incumbent instead of hanging. The
build is still valid. Pass `--posixly-correct` to drop the cap and let CBC run until it
proves optimality — this can take a very long time on those degenerate cases.

### Output control

| Flag          | Meaning                                                                  |
|---------------|--------------------------------------------------------------------------|
| `--json`      | Emit a structured JSON document instead of tables.                       |
| `--import FILE` | Re-render a JSON document saved from `--json` (use `-` for stdin): reproduces the human-readable tables and echoes the exact command line that produced it, without re-solving (so it works even without PuLP). All other solve options are ignored. |
| `--no-color`  | Disable ANSI colors (also auto-disabled when output is not a terminal).  |
| `--charset`   | Table characters: `auto` (by locale, default), `unicode`, or `ascii`.    |

The JSON document is **self-describing and round-trippable**. It opens with a
`command` block — `argv` (the verbatim argument list) and `line` (a shell-quoted
command) — recording the exact invocation that produced it. It then includes the weight
class, the full constraints (with `exact`, a `divisor` integer (or null), and a `nice`
flag per stat), the `match` triples (each `[stat_a, stat_b, tolerance]`, where
tolerance 0 means equal and a positive value is the `~` mode's allowed gap — 10 for
combat pairs, 100 for `hp~st`), the `pawn` and `no_early_switcheroo` flags and any
`avoided_vocations`,
the `bias` list plus a structured `bias_tiers` array (each `{sign, stats}`, preserving
tier grouping and +/- emphasis), the `maximize` / `minimize` lists, the solver used, the
`requested` / `found` counts, and a `builds` array. Each build reports its `start`
vocation, per-range `levels`, `vocation_switches`, `final_stats`, a `totals` object
(`combat` / `vitals` / `all`), a `feasible` flag, and an `owoc_url` (a shareable link
that opens the build in the [owoc.github.io](https://owoc.github.io) planner). Infeasible and interrupted runs
carry the same context block (with an empty `builds` array) so they import too. Stat
keys stay lowercase (`hp`, `attack`, `mattack`, …) regardless of display formatting.

Feed any such document back with `--import` to reprint the tables exactly as the original
run rendered them:

```console
$ ddda-build-solver.py --match attack=mattack --weight LL --json > build.json
$ ddda-build-solver.py --import build.json      # same tables, plus the original command line
```

## Examples

```console
# Minimum HP and stamina, everything else default
$ ddda-build-solver.py --hp-min 3600 --st-min 4000

# Pin attack to an exact value, output 3 distinct builds
$ ddda-build-solver.py --attack 550 --count 3

# Keep physical and magick stats equal, fewest vocation changes
$ ddda-build-solver.py --match attack=mattack,defense=mdefense --minimize-vocations

# Keep attack and mattack within 10 points of each other (approximate match)
$ ddda-build-solver.py --match attack~mattack

# Plan a pawn build (no Mystic Knight / Magick Archer / Assassin)
$ ddda-build-solver.py --pawn

# Exclude specific vocations from consideration
$ ddda-build-solver.py --avoid sorcerer,assassin

# Heavy character, "nice" HP, machine-readable output
$ ddda-build-solver.py --weight LL --nice hp --json

# Force every final stat to a "nice" number
$ ddda-build-solver.py --nice all

# Round every stat to a multiple of 100
$ ddda-build-solver.py --divisor 100

# Per-stat divisors: attack a multiple of 10, mattack a multiple of 20
$ ddda-build-solver.py --divisor attack=10,mattack=20

# Hard-maximize attack first, then defense (priority order)
$ ddda-build-solver.py --maximize attack,defense

# Softly favor combat stats, hard-minimize HP, no built-in default floors
$ ddda-build-solver.py --no-default --bias combat --minimize hp

# Bias attack and mattack equally (tier 1), then mdefense (tier 2)
$ ddda-build-solver.py --bias attack=mattack,mdefense

# Favor attack, de-emphasize mattack (negative bias)
$ ddda-build-solver.py --bias=attack,-mattack

# Save a result as JSON, then re-render it later (reproduces tables + command line)
$ ddda-build-solver.py --nice all --weight LL --json > build.json
$ ddda-build-solver.py --import build.json
```

## Notes & caveats

- **Final level is always 200.** The three ranges (9 + 90 + 100 levels) are fixed.
- **Infeasible constraints are reported as such.** The ILP solver proves when no build
  can satisfy your targets, rather than silently returning a near-miss.
- **"vocation switches" and `--minimize-vocations` measure different things.** The
  *vocation switches* line counts **leveling blocks** — the distinct vocations in each
  of the three ranges, summed, minus one. A vocation that appears in two ranges counts
  as two blocks (you switch away and back), so the number is an upper bound on real
  switches and won't collapse a vocation that happens to continue across a range
  boundary. `--minimize-vocations`, by contrast, minimizes the count of **distinct
  vocations used at all** (a reused vocation counts once) — so it can lower the
  distinct-vocation count without lowering the switches line by the same amount.
- **`--match` exact (`=`) links are transitive** in the constraints display: `a=b,b=c`
  ties all three, and the shown min/max for each becomes the tightest (intersected) bound
  of the group. Approximate (`~`) links do not merge bounds, since the stats need not
  share a value — only stay within the tolerance (10 for combat pairs, 100 for `hp~st`).
- **The growth data assumes the patched (non-vanilla) Magick Archer `to200` values.**
  The owoc planner links use the planner's patched mode (`a` prefix) to match.
- **The owoc planner link encodes the leveling plan losslessly.** The solver only ever
  levels basic vocations in the 1→10 range (as the game requires), which is exactly what
  the planner's pre-10 fields encode, so the vocation allocation maps onto the planner
  without approximation.
- **The owoc planner ignores weight class (it always assumes M).** Weight class only
  affects base stamina, so opening a non-`M` build via its planner link will show a
  slightly different **st** total than this tool reports — the planner has no field for
  it. This tool accounts for the weight class and is the source of truth for **st**; the
  other five stats are identical in both. (All the example URLs above happen to be `M`.)
