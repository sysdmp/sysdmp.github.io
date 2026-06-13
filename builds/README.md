# Exported builds

Saved solver results. Two flavors live here:

- **`*.json`** — machine-readable documents from `ddda-build-solver.py --json`.
  These are self-describing: each embeds the exact command line that produced it
  and can be replayed.
- **`*.txt`** — plain captures of the human-readable tables (handy for a quick look
  without running the tool).

## Re-render a saved JSON build

```console
$ ddda-build-solver.py --import builds/balanced-arisen.json
```

This reprints the tables exactly as the original run produced them and echoes the
command line that made it — no re-solving, so it works even without PuLP installed.

## Reproduce / tweak a build from scratch

Each `.json` records the original invocation under `command.line`. Read it and re-run:

```console
$ jq -r .command.line builds/balanced-arisen.json
ddda-build-solver.py --no-default --bias attack=mattack,st --match attack=mattack ... --json
```

Run that line (drop `--json` for tables) to recompute the build, or edit a flag to
explore a variation.

## Save a new build here

```console
$ ddda-build-solver.py --weight LL --nice all --json > builds/heavy-nice.json
```
