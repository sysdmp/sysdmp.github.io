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

Run with no arguments to solve the balanced objective with no stat constraints at
all (every stat unconstrained):

```console
$ uv run ddda-build-solver.py
```

Tighten or relax any stat with `--<stat>-min` / `--<stat>-max`, pin one exactly with
`--<stat>`, and layer on the [ILP-only goals](#ilp-only-goals) as needed.

## Output

By default the tool prints colored ASCII/Unicode tables: the target constraints (with
a single `round` column showing each stat's rounding mode), and for each build a
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
+----------+--------+--------------+
| range    | levels | vocations    |
+----------+--------+--------------+
| start    |      - | fighter      |
| 1->10    |      9 | mage x9      |
| 10->100  |     90 | fighter x90  |
| 100->200 |    100 | warrior x100 |
+----------+--------+--------------+
 ⚠  changing vocation before level 10:
    to do it, restart the game in Hard Mode — this resets save
    progress, but the character keeps its levels and items.
 vocation switches: 2 (3 leveling blocks across the 3 ranges)
                      final stats
+--------------+-------+---------------------------------+
| stat         | value | details                         |
+--------------+-------+---------------------------------+
| hp           |  4478 | -                               |
| st           |  3570 | -                               |
| attack       |   658 | -                               |
| defense      |   667 | -                               |
| mattack      |   276 | -                               |
| mdefense     |   177 | -                               |
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
 owoc planner: https://owoc.github.io/#af5a0000000000000000000000640000000000000009
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

Omit a bound to leave it unconstrained. There are no built-in default floors — a stat
with no `--<stat>`/`--<stat>-min`/`--<stat>-max` is fully unconstrained.

### ILP-only goals

These are honored only by the exact (`ilp`) solver; the `search` solver ignores them
with a warning.

**Rounding** — force stats to a "round" value. This drops the stat's max bound and keeps
its min as a floor; an exact `--<stat>` value overrides it.

| Flag             | Forces each listed stat to…                                                  |
|------------------|------------------------------------------------------------------------------|
| `--divisor SPEC` | a **multiple of a divisor**. A bare number applies to every stat (`--divisor 100` → multiples of 100; 50 = half-perfect, 10 = round decimal). Or give per-stat `stat=N` segments: `--divisor attack=10,mattack=20`. Group keywords work (`--divisor combat=50`), and later segments override earlier ones. (For "nice"/repdigit values like 4444, use a divisor — e.g. `--divisor hp=1111`.) |

**Other goals:**

| Flag                    | Meaning                                                                                          |
|-------------------------|--------------------------------------------------------------------------------------------------|
| `--match PAIRS`         | Comma-separated stat pairs tied together. `a=b` forces **equal** final values; `a~b` lets them differ by at most **10** points for combat pairs, or **100** for the `hp~st` pair (e.g. `attack~mattack` might give 490 / 500). Mix freely: `attack=mattack,defense~mdefense`. The keyword `all` expands to the three exact pairings `attack=mattack,defense=mdefense,hp=st`. Each stat's own min/max still applies. |
| `--bias SPEC`           | Comma-separated `stat=N` weights softly favoring (`N>0`) or reducing (`N<0`) stats, `N` in **−5..5** — the same per-stat scale as the web UI's slider. Larger `\|N\|` = stronger; stats sharing the same `\|N\|` and sign are weighted equally (one tier). E.g. `--bias attack=5,mattack=3,mdefense=3` favors attack most, then mattack and mdefense together. Positively-biased stats are guaranteed to grow (an equal-share floor proportional to their tier), then the weighted total maximizes within that. A bare stat means `=5`; group keywords expand — `combat=3` sets all four combat stats to 3, bare `combat` to 5 (see below). Use the `--bias=...` form so a leading `-` survives argparse. A soft preference; use `--maximize` for a hard guarantee. |
| `--maximize STATS`      | Comma-separated stats to **hard-maximize**, highest priority first (lexicographic): `attack,defense` maxes attack, then maxes defense without giving up attack. The **top** priority — each stat is driven to its **global** optimum over the build structure (pool/pawn/weight/no-switcheroo) *first*, with your `--STAT`/`--STAT-min`/`--STAT-max`/`--divisor`/`--match` targets applied only **within** that optimum. A target that conflicts with the peak is **infeasible**, not silently relaxed: `--maximize attack --hp-min 3220` behaves like `--attack <max> --hp-min 3220`. Sits above the total-stat objective. |
| `--require SPEC`        | Force a vocation to take at least N levels in a range, as comma-separated segments: `voc=N` (the **10→100** range) or `voc:RANGE=N` where RANGE is `10` / `100` / `200`. E.g. `--require warrior=40,fighter:10=9,sorcerer:200=30`. Ranges hold 9 / 90 / 100 levels; each range's minimums must fit, and **1→10 is basic-vocations only**. A **hard, structural** constraint (holds under `--maximize` too); a required vocation is implicitly allowed (rejected if `--avoid`ed/pawn-excluded). |

**Group keywords** — anywhere a `STATS` list is accepted (`--divisor`, `--bias`,
`--maximize`), two shorthands expand to multiple stats:

- `all` → every stat (`hp,st,attack,defense,mattack,mdefense`).
- `combat` → the four combat stats (`attack,defense,mattack,mdefense`).

**Balanced objective (no `--bias`):** the solver maximizes a *weighted* total of
the final stats, with **hp and st discounted** (weight 0.1 vs 1.0 for the combat
stats). hp/st have large raw values and grow cheaply, so this stops the balanced
build from piling level-ups into them at the expense of combat stats.

### Character

| Flag             | Meaning                                                                 |
|------------------|-------------------------------------------------------------------------|
| `--weight CLASS` | Weight class, which sets base stamina, stamina-regen rate, and max encumbrance. One of `SS`, `S`, `M`, `L`, `LL` (default `M`); case-insensitive. |
| `--avoid VOCS`   | Comma-separated vocations to drop from consideration entirely (never leveled in any range, and excluded as a start vocation). |
| `--start-as VOC` | Force the starting (level-1) vocation to one basic: `fighter`, `strider`, or `mage`. By default the solver picks the best-scoring start among the allowed basics. Honored by both solvers. |
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
| `--count N`  | Number of builds to output (default 1). Builds past the first are alternate leveling paths to the **same optimal stats** — not worse-stat builds; fewer than N if the optimum is unique. |
| `--seed N`   | Base RNG seed; runs are reproducible per seed (default 0). Affects `search` only.  |
| `--seeds N`  | `search`: number of random restarts (default 8).                                   |
| `--iters N`  | `search`: iterations per seed (default 1,500,000).                                 |

The ILP solver is exact and fast. It runs in two phases: first it evaluates every
allowed start vocation and picks the build that best satisfies the objective, which
fixes the optimal final stats; then, when `--count > 1`, it enumerates additional
builds that reach **those exact stats** via different leveling paths, using no-good
cuts (so the extras are genuine alternatives, never lower-stat consolation builds).
This mirrors the web app's "find alternatives" button. The `search` solver is a
stochastic hill-climb used only as a fallback when PuLP is unavailable.

The objective's weights are scaled to integers and, when several builds tie at the
optimal score, a deterministic combat-first tie-break (attack → defense → mattack →
mdefense → hp → st) — applied both within a start and across starts — selects one
canonical stat-vector. This is the **same** scheme the web solver uses, so both return
identical stats for the same input (the leveling path may still differ); the
cross-validation harness asserts that stat-for-stat. A side effect: the canonical
optimum is usually uniquely reachable, so `--count > 1` typically returns just one
build.

Each CBC solve is capped at a few seconds: some flag combinations (e.g. `--divisor 100`
with a continuous `--bias`) leave CBC holding the optimum but unable to *prove* it
quickly, so it returns the best feasible incumbent instead of hanging. The build is
still valid.

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
class, the full constraints (with `exact` and a `divisor` integer (or null) per stat),
the `match` triples (each `[stat_a, stat_b, tolerance]`, where
tolerance 0 means equal and a positive value is the `~` mode's allowed gap — 10 for
combat pairs, 100 for `hp~st`), the `pawn` and `no_early_switcheroo` flags and any
`avoided_vocations`,
the `bias` list, a `bias_map` (`{stat: signed N}`, the −5..5 weight per stat) and a
structured `bias_tiers` array (each `{sign, stats}`, preserving tier grouping and +/−
emphasis), the `maximize` list, the solver used, the
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
# Minimum HP and stamina, everything else unconstrained
$ ddda-build-solver.py --hp-min 3600 --st-min 4000

# Pin attack to an exact value, show up to 3 leveling paths to the best stats
$ ddda-build-solver.py --attack 550 --count 3

# Keep physical and magick stats equal
$ ddda-build-solver.py --match attack=mattack,defense=mdefense

# Keep attack and mattack within 10 points of each other (approximate match)
$ ddda-build-solver.py --match attack~mattack

# Plan a pawn build (no Mystic Knight / Magick Archer / Assassin)
$ ddda-build-solver.py --pawn

# Exclude specific vocations from consideration
$ ddda-build-solver.py --avoid sorcerer,assassin

# Force the start as Mage, and require 40 of the 10->100 levels in Warrior
$ ddda-build-solver.py --start-as mage --require warrior=40

# Round every stat to a multiple of 100
$ ddda-build-solver.py --divisor 100

# Per-stat divisors: attack a multiple of 10, mattack a multiple of 20
$ ddda-build-solver.py --divisor attack=10,mattack=20

# "Nice" repdigit HP (a multiple of 1111: 3333, 4444, ...), machine-readable output
$ ddda-build-solver.py --weight LL --divisor hp=1111 --json

# Hard-maximize attack first, then defense (priority order)
$ ddda-build-solver.py --maximize attack,defense

# Favor combat stats, de-emphasize HP (negative weight)
$ ddda-build-solver.py --bias=combat=5,hp=-3

# Favor attack most (5), then mattack and mdefense together (3)
$ ddda-build-solver.py --bias attack=5,mattack=3,mdefense=3

# Favor attack, de-emphasize mattack
$ ddda-build-solver.py --bias=attack=5,mattack=-3

# Save a result as JSON, then re-render it later (reproduces tables + command line)
$ ddda-build-solver.py --divisor all=50 --weight LL --json > build.json
$ ddda-build-solver.py --import build.json
```

## Notes & caveats

- **Final level is always 200.** The three ranges (9 + 90 + 100 levels) are fixed.
- **Infeasible constraints are reported as such.** The ILP solver proves when no build
  can satisfy your targets, rather than silently returning a near-miss.
- **The "vocation switches" line counts leveling blocks.** It's the distinct vocations
  in each of the three ranges, summed, minus one. A vocation that appears in two ranges
  counts as two blocks (you switch away and back), so the number is an upper bound on
  real switches and won't collapse a vocation that happens to continue across a range
  boundary.
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
