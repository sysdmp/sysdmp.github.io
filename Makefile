# SPDX-License-Identifier: MIT
# Build the single self-contained index.html for static hosting (gh-pages).
#
# src/build.mjs bundles src/app.js + solver + data + the HiGHS WASM factory (with
# its .wasm inlined as base64) and splices that minified JS into src/index.html's
# placeholder, writing one self-contained index.html at the repo root — no
# separate .js/.wasm, no node_modules, no runtime fetches. Drop that single file
# (plus nothing else) on gh-pages.

OUT := index.html

.PHONY: all build test clean

all: build

build: $(OUT)

$(OUT): $(wildcard src/*.js) src/index.html src/build.mjs package.json
	node src/build.mjs

test:
	npm test

clean:
	rm -f $(OUT)
