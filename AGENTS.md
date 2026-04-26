# Repository Guidelines

## Project Structure & Module Organization

`MyMem` is an OpenClaw memory plugin that runs TypeScript directly. The package entrypoint is `index.ts`, which wires registration, hooks, tools, CLI commands, and singleton lifecycle state. Most implementation lives in `src/`: storage in `src/store.ts`, retrieval in `src/retriever.ts`, embeddings in `src/embedder.ts`, extraction in `src/smart-extractor.ts`, hook modules in `src/*-hook.ts`, and reflection/session utilities in `src/reflection-*` and `src/session-compressor.ts`. Tests live in `test/` as `.mjs` or `.test.mjs` files. Documentation is in `README.md` and `docs/`. Public plugin configuration is defined in `openclaw.plugin.json`.

## Build, Test, and Development Commands

There is no build step; source is executed through Node/Jiti.

- `node scripts/run-ci-tests.mjs --all` runs the authoritative CI manifest.
- `node scripts/run-ci-tests.mjs --group core-regression` runs one CI group; other groups include `cli-smoke`, `storage-and-schema`, `llm-clients-and-auth`, and `packaging-and-workflow`.
- `npm test` runs the legacy aggregate test script; prefer the CI manifest when validating broad changes.
- `node test/<file>.mjs` runs direct tests.
- `node --test test/<file>.test.mjs` runs tests using the Node test runner.
- `npm run bench`, `npm run bench:locomo`, and `npm run bench:longmemeval` run benchmarks.

If TypeScript changes behave unexpectedly, clear Jiti cache with `rm -rf node_modules/.cache/jiti`.

## Coding Style & Naming Conventions

Use ES modules and TypeScript in source files. Keep changes focused and consistent with nearby code. Prefer small extracted utilities over expanding `index.ts`. Use descriptive names, kebab-case filenames such as `auto-recall-hook.ts`, and test names that describe the behavior under regression. Preserve compatibility with legacy memory categories unless intentionally changing the public API.

## Testing Guidelines

Add or update tests in `test/` for behavior changes. Use `.test.mjs` with `node:test` when matching adjacent tests; otherwise plain `.mjs` direct tests are common. Tests importing TypeScript via Jiti should create it with `jitiFactory(import.meta.url, { interopDefault: true })`. Start with the smallest relevant CI group, then run broader groups for shared files like `index.ts`, `src/store.ts`, or `src/retriever.ts`.

## Commit & Pull Request Guidelines

Git history follows concise Conventional Commit-style subjects, for example `fix(reflection): add memory_category to metadata` or `refactor: create hook registration modules`. Use an imperative subject with an optional scope. Pull requests should include a problem statement, implementation summary, test commands run, linked issues, and notes for configuration, schema, or public tool changes.

## Security & Configuration Tips

Do not commit API keys, OAuth tokens, local databases, or generated memory stores. Keep `package.json` and `openclaw.plugin.json` versions synchronized via `npm version`, which runs `scripts/sync-plugin-version.mjs`.


<claude-mem-context>
# Memory Context

# [mymem-main] recent context, 2026-04-26 7:09pm GMT+8

No previous sessions found.
</claude-mem-context>
