# Build the self-contained, minified bundle for static hosting (gh-pages).
#
# `make` bundles src/app.js and everything it imports — the solver, data, and the
# HiGHS WASM factory with its .wasm inlined as base64 — into a single index.js.
# index.html loads only that file, so the deployable site is index.html + index.js
# (no node_modules, no separate .wasm, no network fetches at runtime).

ESBUILD := npx --no-install esbuild
ENTRY   := src/app.js
OUT     := index.js

.PHONY: all build test clean

all: build

build: $(OUT)

# The `binary` loader inlines `highs/runtime` (the .wasm) as bytes; highs-loader.js
# passes them to the factory as wasmBinary, so no runtime wasm fetch is needed.
$(OUT): $(wildcard src/*.js) package.json
	$(ESBUILD) $(ENTRY) \
		--bundle \
		--minify \
		--format=iife \
		--platform=browser \
		--target=es2020 \
		--loader:.wasm=binary \
		--external:node:* \
		--legal-comments=none \
		--outfile=$(OUT)
	@echo "built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

test:
	npm test

clean:
	rm -f $(OUT)
