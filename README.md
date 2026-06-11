# ddda-build-solver

A command-line solver for **Dragon's Dogma: Dark Arisen** character builds. Tell it
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

In Dragon's Dogma, your six core stats grow automatically each level, and how much
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
base plus the summed per-level gains. The growth tables are mirrored from the game's
own `js/planner.js` data.

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
st ≥ 3500, attack/mattack ≥ 500, defense/mdefense ≥ 300):

```console
$ uv run ddda-build-solver.py
```

Tighten or relax any stat with `--<stat>-min` / `--<stat>-max`, pin one exactly with
`--<stat>`, and layer on the [ILP-only goals](#ilp-only-goals) as needed.

## Output

By default the tool prints colored ASCII/Unicode tables: your weight class, the
target constraints, and for each build a **leveling plan** (which vocation to level in
each range) and the resulting **final stats** (green if a stat meets its requirement,
red if not).

```text
solver: ILP (exact)

found 1 build(s):

====================================================
 build 1   [OK] all requirements met
 start vocation: fighter
====================================================
                              leveling plan
+----------+--------+-----------------------------------------------------+
| range    | levels | vocations                                           |
+----------+--------+-----------------------------------------------------+
| 1->10    |      9 | strider x1  mage x8                                  |
| 10->100  |     90 | fighter x40  sorcerer x50                           |
| 100->200 |    100 | strider x30  warrior x53  sorcerer x15  assassin x2 |
+----------+--------+-----------------------------------------------------+
          final stats
+----------+-------+-------------+
| stat     | value | requirement |
+----------+-------+-------------+
| hp       |  3506 | >=3500      |
| st       |  3500 | >=3500      |
| attack   |   501 | >=500       |
| ...      |       |             |
+----------+-------+-------------+
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

Omit a bound to leave it unconstrained. Defaults: `hp`/`st` min 3500, `attack`/`mattack`
min 500, `defense`/`mdefense` min 300, no maximums.

### ILP-only goals

These are honored only by the exact (`ilp`) solver; the `search` solver ignores them
with a warning.

| Flag                    | Meaning                                                                                          |
|-------------------------|--------------------------------------------------------------------------------------------------|
| `--perfect STATS`       | Comma-separated stats forced to a **multiple of 100**. The max bound is dropped; min kept as a floor. |
| `--neat STATS`          | Comma-separated stats forced to a **"neat" number**: `666`, ending in `42` or `69`, all-same-digit (e.g. `444`), or a multiple of 100. Max dropped, min kept. |
| `--match PAIRS`         | Comma-separated stat pairs forced to **equal** final values, e.g. `attack=mattack,defense=mdefense`. Each stat's own min/max still applies. |
| `--minimize-vocations`  | Among feasible builds, prefer ones that use **fewer distinct vocations** (fewer vocation changes). |

### Character

| Flag             | Meaning                                                                 |
|------------------|-------------------------------------------------------------------------|
| `--weight CLASS` | Weight class, which sets initial stamina and stamina-regen rate. One of `SS`, `S`, `M`, `L`, `LL` (default `M`). |

| Class | Body weight     | Init stamina | Stamina regen |
|-------|-----------------|--------------|---------------|
| SS    | under 50 kg     | 500          | 53/s (125%)   |
| S     | 50–69 kg        | 520          | 48/s (115%)   |
| M     | 70–89 kg        | 540          | 42/s (100%)   |
| L     | 90–109 kg       | 560          | 38/s (90%)    |
| LL    | 110 kg and over | 580          | 31/s (75%)    |

Stamina regen is informational (it does not affect the solve).

### Solver

| Flag         | Meaning                                                                            |
|--------------|------------------------------------------------------------------------------------|
| `--solver`   | `auto` (ILP if PuLP installed, else search — default), `ilp`, or `search`.         |
| `--count N`  | Number of **distinct** feasible builds to output (default 1).                      |
| `--seed N`   | Base RNG seed; runs are reproducible per seed (default 0). Affects `search` only.  |
| `--seeds N`  | `search`: number of random restarts (default 8).                                   |
| `--iters N`  | `search`: iterations per seed (default 1,500,000).                                 |

The ILP solver is exact and fast; it tries starting vocations in order (`fighter`
first) and enumerates distinct builds via no-good cuts when `--count > 1`. The
`search` solver is a stochastic hill-climb used only as a fallback.

### Output control

| Flag          | Meaning                                                                  |
|---------------|--------------------------------------------------------------------------|
| `--json`      | Emit a structured JSON document instead of tables.                       |
| `--no-color`  | Disable ANSI colors (also auto-disabled when output is not a terminal).  |
| `--charset`   | Table characters: `auto` (by locale, default), `unicode`, or `ascii`.    |

The JSON document includes the weight class, the full constraints (with `exact` /
`perfect` / `neat` flags), the `match` pairs, the solver used, and a `builds` array.
Each build reports its `start` vocation, per-range `levels`, `final_stats`, and a
`feasible` flag. Stat keys stay lowercase (`hp`, `attack`, `mattack`, …) regardless of
display formatting.

## Examples

```console
# Minimum HP and stamina, everything else default
$ ddda-build-solver.py --hp-min 3600 --st-min 4000

# Pin attack to an exact value, output 3 distinct builds
$ ddda-build-solver.py --attack 550 --count 3

# Keep physical and magick stats equal, fewest vocation changes
$ ddda-build-solver.py --match attack=mattack,defense=mdefense --minimize-vocations

# Heavy character, "neat" HP, machine-readable output
$ ddda-build-solver.py --weight LL --neat hp --json
```

## Notes & caveats

- **Final level is always 200.** The three ranges (9 + 90 + 100 levels) are fixed.
- **Infeasible constraints are reported as such.** The ILP solver proves when no build
  can satisfy your targets, rather than silently returning a near-miss.
- **`--minimize-vocations` counts distinct vocations**, not the number of in-game
  vocation switches; a vocation used in two ranges counts once.
- **`--match` is transitive** in the constraints display: `a=b,b=c` ties all three, and
  the shown min/max for each becomes the tightest (intersected) bound of the group.
- **The growth data assumes the patched (non-vanilla) Magick Archer `to200` values.**
