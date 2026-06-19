// SPDX-License-Identifier: MIT
// Loads the HiGHS WASM solver and returns an initialized instance.
//
// HiGHS ships a UMD bundle plus a separate .wasm file. To produce a single
// self-contained bundle (for gh-pages), the build inlines the wasm bytes here:
// esbuild's `binary` loader turns the `highs/runtime` import into an embedded
// Uint8Array, which we hand to the factory as `wasmBinary` so no second network
// fetch (and no locateFile path juggling) is needed.

import Module from 'highs';            // UMD factory (esbuild resolves the default)
import wasmBinary from 'highs/runtime'; // .wasm bytes, inlined by the `binary` loader

let instance = null;

// Initialize HiGHS once; subsequent calls return the same instance.
export async function loadHighs() {
  if (instance) return instance;
  instance = await Module({ wasmBinary });
  return instance;
}
