// SPDX-License-Identifier: MIT
// Build the single self-contained index.html for static hosting (gh-pages).
//
// esbuild bundles src/app.js + solver + data + the HiGHS factory with its .wasm
// inlined as base64 into one minified IIFE; we then splice that JS into the
// /*__BUNDLE__*/ placeholder in src/index.html (whose CSS is already inline),
// writing a single index.html at the repo root. No separate .js/.wasm, no
// node_modules, no runtime fetches — the whole app is one HTML file.
//
// Run: node src/build.mjs   (or `make`)

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Single source of truth for the web app version: package.json's "version".
// `npm version x.y.z` bumps it and creates the matching git tag. The bump
// policy is classic semver; bump the minor (y) whenever the share-URL params
// change (so an old link can be recognized as a different schema).
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const result = await build({
  entryPoints: [join(HERE, 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  loader: { '.wasm': 'binary' }, // inline the HiGHS wasm as bytes (base64)
  external: ['node:*'], // drop HiGHS's dead Node-only branches
  legalComments: 'none',
  // Inject the version as a compile-time constant; app.js reads __APP_VERSION__.
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  write: false, // keep the output in memory; we inline it ourselves
});

const js = result.outputFiles[0].text;

// Splice into the template. Escape any "</script" / "<!--" the minified JS might
// contain so it can't terminate the inline <script> or open an HTML comment.
const safeJs = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const template = readFileSync(join(HERE, 'index.html'), 'utf8');
if (!template.includes('/*__BUNDLE__*/')) {
  throw new Error('src/index.html is missing the /*__BUNDLE__*/ placeholder');
}
const html = template
  .replace('/*__BUNDLE__*/', () => safeJs)
  .replaceAll('__APP_VERSION__', VERSION); // footer (and anywhere else in the template)

const out = join(ROOT, 'index.html');
writeFileSync(out, html);
console.log(`built index.html v${VERSION} (${html.length} bytes)`);
