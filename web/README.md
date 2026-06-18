# ddda-build-solver (web)

A serverless, browser-only MILP solver for Dragon's Dogma: Dark Arisen level-200
builds. This is the **primary** implementation going forward; the Python tool in
the repo root is a finished prototype/reference.

It is a **library**, not a CLI: a solver function you call with options, returning
a build object. No argument parsing, no rendering.

## Status

Minimum viable solver: **maximize total stat sum** (all six stats, equal weight),
with no specifiers yet. Specifiers (min/max bounds, divisor rounding, nice
numbers, match, bias, maximize/minimize, pawn rule) are layered on incrementally.

- `data.js` — growth tables and helpers (`statsOf`, `growth`), ported from the
  prototype. The patched (non-vanilla) Magick Archer values.
- `solver.js` — `solveMaxTotal(glpk, opts)`: builds one MILP per basic start
  vocation (integer level-counts per (vocation, tier), block-size constraints),
  maximizes the stat sum, and returns the best build across starts.

## License

GPLv3-or-later. It links **glpk.js** (GPLv3-or-later; itself wrapping GLPK), so
the copyleft applies to this web library. (The root Python prototype is a
separate work and keeps its own license.)

## Usage

```js
import GLPK from 'glpk.js';                 // browser: async/web-worker API
import { solveMaxTotal } from './solver.js';

const glpk = await GLPK();
const build = await solveMaxTotal(glpk);
// -> { start, counts: {to10, to100, to200}, stats, total }
```

`solveMaxTotal` also accepts `{ allowed: [...vocations], startPool: [...basics] }`
to restrict the vocation pool.

## Solver backend

[glpk.js](https://github.com/jvail/glpk.js) — a WebAssembly MILP solver with a
JSON problem model (~287 KB wasm). The browser entry runs in a web worker
(`await glpk.solve(...)`); the Node entry (`glpk.js/node`) is synchronous and used
for testing. The same `solver.js` works against both, since `await` on a
synchronous return is a no-op.

## Testing

The build problem's objective is linear and separable per tier, so the optimum
has a closed form (each tier takes all its levels in the highest stat-sum-per-
level vocation). `test.mjs` uses that as an independent oracle to check the MILP
solver, plus structural invariants (block sizes, basics-only 1→10, pool limits):

```sh
cd web && npm install
node test.mjs
```
