.PHONY: fmt fmt-check lint test clean deps all gen

TS_FILES := $(shell find src -name "*.ts" -type f ! -name "*.test.ts" ! -name "*.gen.ts")

all: gen build fmt lint test

gen: src/codersdk.gen.ts

src/codersdk.gen.ts: scripts/typegen/main.go scripts/typegen/zod.go scripts/typegen/go.mod
	@cd scripts/typegen && go run . > ../../src/codersdk.gen.ts.tmp
	@mv src/codersdk.gen.ts.tmp src/codersdk.gen.ts
	@bun run format -- src/codersdk.gen.ts || true

fmt:
	bun run format

fmt-check:
	bun run format:check

lint:
	bun run lint
	bun run typecheck

dist/index.js: $(TS_FILES) src/codersdk.gen.ts package.json bun.lock node_modules
	bun run build

build: dist/index.js

test:
	bun test

clean:
	rm -rf dist

node_modules: package.json bun.lock
	bun install
	touch node_modules

deps: node_modules
