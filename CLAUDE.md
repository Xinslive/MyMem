# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MyMem is a single-package TypeScript ESM OpenClaw memory plugin. It provides long-term memory through automatic conversation capture, LLM-based extraction, LanceDB storage, hybrid retrieval, scope isolation, lifecycle/governance logic, reflection, and an operator CLI.

The runtime has two main entrypoints:

- `index.ts` registers the OpenClaw plugin, lifecycle hooks, memory runtime stub, auto-capture/auto-recall/reflection/session hooks, dashboard startup, and tool registration.
- `cli.ts` implements the `openclaw mymem ...` command surface for local management, diagnostics, import/export, reflection, dashboard, and maintenance workflows.

The package is ESM (`"type": "module"`) and TypeScript is compiled with `moduleResolution: "NodeNext"`, so local TypeScript imports use explicit `.js` specifiers.

## Development commands

- Install dependencies: `npm install`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Apply safe lint fixes: `npm run lint:fix`
- Run all CI tests: `npm test`
- Run one CI test group: `npm run test:core-regression` or another `test:<group>` script from `package.json`
- Run coverage: `npm run test:coverage`
- Run recall evaluation: `npm run test:recall-eval`
- Run benchmarks: `npm run benchmark`
- Sync plugin manifest version from `package.json`: `npm run version`

Single-test execution depends on `scripts/ci-test-manifest.mjs`:

- Manifest entries with `args: ["--test"]`: `node --test test/name.test.mjs`
- Manifest entries without `args`: `node test/name.test.mjs`
- Many tests import TypeScript through `jiti`; no build step is normally required before running tests.

Before adding a new CI-covered test, register it in `scripts/ci-test-manifest.mjs`. `npm run test:packaging-and-workflow` also verifies the manifest before running that group.

After changing `package.json` version, run `npm run version` to sync `openclaw.plugin.json` and stage it.

## High-level architecture

The core engine lives under `src/` and is organized as focused modules with a few public barrel/orchestration files:

- Plugin initialization and singleton wiring: `src/plugin-singleton.ts`, `src/plugin-config-parser.ts`, `src/plugin-registration.ts`, and `index.ts`. Heavy resources such as the store, embedder, retriever, scope manager, and lifecycle components are initialized once and reused across repeated OpenClaw `register()` calls.
- Storage layer: `src/store.ts` wraps LanceDB access, multi-scope filtering, lexical/vector index management, metadata updates, stats caching, batching, and cross-process locking via `proper-lockfile`. Supporting SQL/row mapping/types are split into `src/store-sql-utils.ts`, `src/store-row-mappers.ts`, and `src/store-types.ts`.
- Embedding and model clients: `src/embedder.ts`, `src/embedding-provider.ts`, `src/embedding-cache.ts`, `src/llm-client.ts`, and auth helpers support OpenAI-compatible, Azure/OpenAI-style, Ollama/local, and other provider profiles used by extraction, recall, rerank, and maintenance.
- Retrieval pipeline: `src/retriever.ts` orchestrates query expansion, vector search, BM25/full-text search, RRF fusion, temporal/decay scoring, reranking, MMR diversity, access tracking, diagnostics, and Learning Memory policy. The smaller scoring and diagnostics pieces live in `src/query-expander.ts`, `src/rrf-fusion.ts`, `src/temporal-scoring.ts`, `src/reranker.ts`, `src/mmr-diversity.ts`, `src/retrieval-trace.ts`, and related files.
- Memory model and governance: `src/memory-categories.ts` defines the six user-facing categories: `profile`, `preferences`, `entities`, `events`, `cases`, and `patterns`. `src/smart-metadata.ts`, `src/decay-engine.ts`, `src/tier-manager.ts`, `src/lifecycle-maintainer.ts`, `src/memory-upgrader.ts`, `src/preference-distiller.ts`, `src/feedback-loop.ts`, and `src/learning-memory.ts` handle metadata, lifecycle, promotion/archival, preference distillation, and learned ranking signals.
- Capture and extraction: `src/auto-capture-hook.ts`, `src/auto-capture-cleanup.ts`, `src/capture-detection.ts`, `src/smart-extractor.ts`, `src/smart-extractor-handlers.ts`, `src/smart-extractor-dedup.ts`, `src/extraction-prompts.ts`, and `src/extraction-rate-limiter.ts` convert conversation text into governed memory entries.
- Recall and context injection: `src/auto-recall-hook.ts`, `src/auto-recall-metadata-accumulator.ts`, `src/recall-suppression.ts`, `src/tools-recall.ts`, and `src/retrieval-explain.ts` handle automatic and explicit recall, explanation traces, and injected context formatting.
- Reflection/session memory: `src/reflection-hook.ts`, `src/reflection-store.ts`, `src/reflection-item-store.ts`, `src/reflection-event-store.ts`, `src/reflection-ranking.ts`, `src/reflection-slices.ts`, `src/session-memory-hook.ts`, `src/session-compressor.ts`, and `src/session-recovery.ts` maintain the separate reflection/session pipeline.
- Tools: `src/tools.ts` is the runtime tool registration barrel. The current plugin manifest exposes `mymem_recall` and `mymem_doctor`; other management/store/update modules remain in source for CLI, tests, or compatibility paths.
- UI/ops: `src/dashboard-server.ts`, `src/telemetry.ts`, and scripts under `scripts/` support the local dashboard, telemetry, version sync, CI manifest validation, and governance maintenance.

## Memory model notes

MyMem separates durable knowledge from experience traces:

- Knowledge: `profile`, `preferences`, `entities`, `patterns`
- Experience: `events`, `cases`

Each memory has compact summary/index fields and richer content/metadata. Retrieval should respect scope filters, category semantics, temporal validity, suppression state, lifecycle tier/layer, and whether a path is auto-recall, explicit tool recall, reflection, or maintenance.

Reflection data is stored separately and is used for reflection/session context. It should not be treated as ordinary `mymem_recall` data unless the code path explicitly bridges it.

## Testing and workflow notes

Tests live in `test/` and use Node's built-in test runner plus `jiti` for TypeScript imports. CI groups are defined in `scripts/ci-test-manifest.mjs` and executed by `scripts/run-ci-tests.mjs`.

Some tests start local HTTP mocks, including Ollama-style endpoints on `127.0.0.1:11434`; avoid running conflicting test files in parallel. Prefer the relevant CI group after focused single-test runs when changing shared retrieval, storage, hook, or config behavior.

Coverage thresholds are 60% line / 50% branch (enforced by `c8`).

## Commit conventions

Recent history uses conventional commits: `fix:`, `feat:`, `refactor:`, `perf:`, `docs:`, `chore:`. Keep subjects imperative and scoped. PRs should describe behavior changes, list validation commands run, and call out manifest/config schema changes.

## Coding conventions

- Use strict TypeScript with ESM/NodeNext imports and explicit `.js` specifiers for local source imports.
- Follow the existing two-space indentation and kebab-case source/test filenames.
- ESLint is `@eslint/js` plus `typescript-eslint` strict config. It enforces `prefer-const`, allows intentionally unused variables only with a leading `_`, warns on `any`, allows non-null assertions, and requires described `@ts-expect-error` instead of `@ts-ignore`.
- Public compatibility modules such as `src/store.ts`, `src/retriever.ts`, and `src/tools.ts` re-export types/utilities from focused helper modules; preserve those exports unless intentionally changing the public surface.

## Plugin manifest and config

`openclaw.plugin.json` defines the plugin's config schema (validated at runtime by `@sinclair/typebox`), tool definitions, and hook declarations. Config values support `${ENV_VAR}` syntax resolved by `resolveEnvVars()` in `src/config-utils.ts`. The `openclaw` field in `package.json` points to `index.ts` as the extension entry.

## Documentation sources

- `README.md` explains product behavior, memory taxonomy, retrieval design, dashboard usage, and recommended OpenClaw configuration.
- `TECHNICAL_DOC.md` contains the detailed architecture and subsystem design.
- `AGENTS.md` contains general repository contributor guidance; keep this `CLAUDE.md` aligned with it when repository workflows change.

## Known issues and ongoing audits

- `docs/audit-2026-06-28.md` — design audit covering reliability, performance, security, and maintainability (38 ranked issues, P0–P3). Update this file when fixing items so it doubles as a fix log. Items currently in flight: **#3 (redactSecrets in extract path)**, **#16 (feedback-loop onAdmissionRejected stub)**.
- Before adding new security-sensitive code paths (anything that touches the LLM prompt, stores memory text, or accepts inbound network), re-read the P0/P1 sections of the audit to avoid reintroducing fixed issues.
