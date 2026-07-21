# MyMem Architecture & Maintainability Review — 2026-07-21

**Scope**: Architecture, layering, coupling, hot-file sprawl, public-surface stability, error-handling consistency, plugin-singleton lifecycle, dependency direction.
**Build under review**: HEAD on `main` (post-CR-1..CR-10, post-test-suite-slim).
**Out of scope**: Performance benchmarks, security/PII review (covered in `docs/code-review-2026-06-28.md`), prompt-injection surface.

## Top 8 Findings (ranked by severity)

### F1 — P0: `enableManagementTools` is silently a no-op; ten tool registrations are exported but never wired up

- **File:line**: `src/tools.ts:36-47`, `src/tools.ts:24-32`, `src/plugin-config-parser.ts:318`, `index.ts:265`
- **Evidence**:
  - `index.ts:250-267` forwards `enableManagementTools: config.enableManagementTools` to `registerAllMemoryTools`.
  - `src/tools.ts:36-47` declares the option, immediately runs `void options;`, and only ever registers `mymem_recall`, `mymem_update`, `mymem_doctor`.
  - `src/tools.ts:18-32` still *re-exports* `registerMemoryStoreTool`, `registerMemoryForgetTool`, `registerMemoryStatsTool`, `registerMemoryDebugTool`, `registerMemoryExplainTool`, `registerMemoryListTool`, `registerMemoryPromoteTool`, `registerMemoryArchiveTool`, `registerMemoryCompactTool`, `registerMemoryExplainRankTool`.
  - A repo-wide grep for callers of those ten registration functions turns up only the re-export lines themselves and the function bodies — no runtime invocation. The whole 958-LOC `src/tools-management.ts` (plus `src/tools-store.ts` / `src/tools-forget.ts`) is effectively dead code at the agent tool layer.
  - `openclaw.plugin.json` only lists `mymem_recall`, `mymem_update`, `mymem_doctor` (lines 9-11), which matches what `registerAllMemoryTools` actually wires, so the user-facing contract is intact — but the code path that "honors" the legacy `enableManagementTools` config is dead, and any future operator who toggles it on will see no change.
- **Impact**: Misleading config surface, ~1500 LOC of "legacy management tools" that look first-class but never run. Future agents (or humans) reading CLAUDE.md's note that these tools are kept for "compatibility" cannot tell which are live. Re-introducing any of them silently is one `index.ts` edit away from a config-vs-behavior split (config says "on", runtime never registers).
- **Proposed fix**: Either (a) wire the `enableManagementTools` branch and add the corresponding manifest entries (the larger blast radius), or (b) delete the dead management tool modules and the `enableManagementTools` option, leaving the barrel as a one-tool registration. Option (b) is consistent with CLAUDE.md's statement that the manifest exposes only `mymem_recall` and `mymem_doctor` (plus `mymem_update`).
- **CR-1..CR-10 status**: New issue. Not previously called out.

---

### F2 — P0: `src/smart-metadata.ts` declares `ParseSmartMetadataOptions` twice (TypeScript silently merges)

- **File:line**: `src/smart-metadata.ts:54-63` and `src/smart-metadata.ts:336-344`
- **Evidence**: Both blocks read
  ```
  export interface ParseSmartMetadataOptions {
    onCorrupt?: (raw: string, error: unknown) => void;
  }
  ```
  This is verified with `grep -c "interface ParseSmartMetadataOptions" src/smart-metadata.ts` → `2`. TypeScript merges them, so the build passes — but the second declaration is unreachable by any human reader, the JSDoc on the second copy disagrees with the first ("Listeners should at minimum emit a structured log entry…"), and a future maintainer adding a field to either copy will silently get a merged type that differs from their intent.
- **Impact**: Real source of "spooky action at a distance" when modifying the smart-metadata contract. Also a clear "code-sprawl smell" flag: 923-LOC file has accumulated two declarations of the same interface 280 lines apart.
- **Proposed fix**: Delete the second declaration (lines 336-344). Keep the first.
- **CR-1..CR-10 status**: New issue. Not previously called out.

---

### F3 — P1: Hot files at the 900-2072 LOC scale — `store.ts` mixes five distinct responsibilities

- **File:line**: `src/store.ts` (2072 LOC), `src/tools-management.ts` (958 LOC), `src/smart-metadata.ts` (923 LOC).
- **Evidence**:
  - `src/store.ts` holds: (a) LanceDB table init/migration/index management (lines 545-1142), (b) stats/aggregation (lines 440-475, 1605-1689), (c) CRUD + batch API (lines 1144-1948), (d) lockfile + async-serialization plumbing (lines 76-339), (e) marker-file persistence (lines 1012-1081). These are orthogonal concerns glued to a single class.
  - `src/tools-management.ts` bundles eight tool registrations (`mymem_stats`, `_debug`, `_explain`, `_list`, `_promote`, `_archive`, `_compact`, `_explain_rank`) that share no helper. Even the `registerMemoryCompactTool` body (lines 774-870) is a self-contained mini-pipeline.
  - `src/smart-metadata.ts` contains (a) raw metadata normalization (lines 60-468), (b) the build/patch API (lines 470-594), (c) contextual support v1/v2 schema (lines 713-877), (d) `LazyMetadata` lazy parse wrapper (lines 886-923). The v1/v2 support slice logic is independent enough that it could be its own module.
- **Impact**: Each of these files scores a 2072/958/923 LOC of "thing that does many things." New contributors must skim the whole file to find the seam they need to modify, which slows code review and pushes changes toward "edit-in-place" instead of "add to the right module." There is no obvious decomposition cost — the public surface is small (`MemoryStore` class, `parseSmartMetadata`/`buildSmartMetadata` functions, the `registerXxxTool` functions), so refactoring would not break the public compatibility contract.
- **Proposed fix**: Split along the seams above.
  - `store.ts`: extract `store-lock.ts` (lockfile + serial chain + flushWrites), `store-index.ts` (LanceDB indices + FTS version + embedding-dimension marker), `store-stats.ts` (the count/scope/category/tier/health aggregation methods). Keep `store.ts` as the public class shell that delegates.
  - `tools-management.ts`: split into `tools-stats.ts`, `tools-debug.ts` (debug + explain + explain_rank), `tools-list-promote-archive.ts` (list/promote/archive), `tools-compact.ts`. The barrel stays identical.
  - `smart-metadata.ts`: extract `smart-metadata-support.ts` (the v1/v2 contextual support code, lines 713-877) and `lazy-metadata.ts` (the `LazyMetadata` class, lines 886-923).
- **CR-1..CR-10 status**: New issue, but adjacent to the spirit of CR-2 ("atomic write strategy coverage incomplete") which already touched several cross-cutting concerns in `store.ts`.

---

### F4 — P1: Re-throws in `src/embedder.ts` consistently drop `cause:`, defeating error chain diagnostics

- **File:line**: `src/embedder.ts:129, 142, 341, 373, 389, 416, 514, 700, 703, 758, 799, 810, 829, 846, 864, 964, 975, 1006`.
- **Evidence**: 17 `throw new Error(...)` sites in `embedder.ts`. Only 4 attach `{ cause }` (`src/embedder.ts:516, 924, 1068, 1079`). `eslint.config.js:35` explicitly disables `preserve-caught-error` with the comment "preserve-caught-error requires attaching cause to all re-throws." Many of the throwing sites wrap an upstream error — e.g. line 373 wraps a failed Ollama response body read with `await readNativeFetchBody(...).catch(() => "")`, line 514 wraps the last rate-limit error, line 846/864 wrap a chunker error — but the chain is lost.
  - The same pattern repeats across `src/store.ts`: 21 `throw new Error` sites, only 6 attach `cause:` (lines 269, 865, 878, 891, 1137, 1178 — all in the LanceDB init / writeBatch / store / bulk import paths). The "outside accessible scopes" and "patchMetadata failed" branches (lines 1519, 1536, 1705, 1721, 1811, 1827, 1843, 1901) drop the LanceDB error object entirely.
  - `src/retriever.ts` and `src/smart-extractor.ts` have **zero** `cause:` usage — retriever's catch at line 303 just re-throws raw, smart-extractor at line 419 does the same. Several `smart-extractor.ts` catch blocks (lines 207, 322, 355, 378, 404, 614, 814) use `String(err)` and re-throw without `cause`.
- **Impact**: When a production incident lands as a stack trace in a dashboard or crash report, the immediate `Error.message` is whatever the throw site chose to embed, but the upstream cause (LanceDB code, fetch failure, embedder SDK rejection) is gone. Operators can no longer pivot from "Embedding is not an array" to "OpenAI returned 502 with X-Request-Id." Audit #5 already pointed at this for the zero-vector case; the fix was a "loud failure at the write site," which is necessary but not sufficient.
- **Proposed fix**: Re-enable `preserve-caught-error` in `eslint.config.js:35`. Patch the 12-14 `throw new Error` sites that wrap an upstream `err` to pass `{ cause: err }`. The "outside accessible scopes" and "patchMetadata failed" sites can stay (they wrap logic errors, not I/O errors).
- **CR-1..CR-10 status**: New issue. Not previously called out, but the disable was a conscious decision documented in eslint.config.js that hasn't been revisited since the file's first cut.

---

### F5 — P1: `src/store.ts` exposes a `runBatch` API whose batch-buffer ownership semantics are too clever for its own comments

- **File:line**: `src/store.ts:163-253` (startBatch/cancelBatch/runBatch/flushBatch + AsyncLocalStorage).
- **Evidence**:
  - `startBatch()` is the "legacy process-wide batch mode" (line 1167: `if (this._batchActive) { ... }`).
  - `runBatch()` sets up a *context-local* batch via AsyncLocalStorage, and `flushBatch()` reads `batchStoreContext.getStore()?.get(this)` first, then falls back to `this._batchBuffer`.
  - `cancelBatch()` *also* checks the ALS first, then the instance-level buffer (lines 169-181).
  - The class docblock at line 207-220 explicitly says "We must NOT clear the context buffer here — that would silently drop user memory" — but the `cancelBatch` ALS branch (lines 170-174) returns the spliced entries without re-entering them into the instance buffer, which is the **opposite** of the runBatch catch branch (lines 214-220). Two paths, two policies, one `_batchBuffer`.
  - `_batchBuffer` and `_batchActive` are still mutated directly from `store()` at line 1168, which is the "Legacy process-wide batch mode: retained for existing direct callers" path. So callers that didn't migrate to `runBatch` still work, but `cancelBatch` will not un-buffer them unless ALS is active.
- **Impact**: This is the kind of subtle correctness trap that works fine in single-call tests and silently drops memory under concurrent or failed-then-retried extraction flows. The smoke test suite can't catch it because it doesn't exercise overlap between `runBatch` and legacy `startBatch`/`store` callers in the same store.
- **Proposed fix**: Pick one ownership model. The cleanest is: remove the legacy `_batchActive`/`_batchBuffer` instance fields entirely, gate `store()` writes through the ALS only, and treat any non-ALS caller as the default "no batching" path (i.e. immediate `runWithFileLock + table.add`). Document the contract in `runBatch`'s JSDoc and delete `startBatch`/`cancelBatch`'s dual-mode branches.
- **CR-1..CR-10 status**: New issue. Adjacent to CR-7 (mutation audit queue / flush drainability), which extended a similar pattern to the audit logger.

---

### F6 — P1: `index.ts` `register()` body is a 660-line monster that does too much

- **File:line**: `index.ts:89-752` (the whole `register(api)` method, plus the 56-line `destructure-and-discard` block at 106-138).
- **Evidence**:
  - The destructure block `index.ts:106-138` pulls **29** properties out of the singleton state, and **15** of them are renamed with a leading `_` to silence `no-unused-vars` (`_reflectionErrorStateBySession`, `_reflectionDerivedBySession`, `_reflectionByAgentCache`, etc.). The comment chain at lines 65-66 explicitly says these are tracked in singleton state but **never read in `register()`**. They are only consumed by the deeply nested hooks/services below.
  - `index.ts` then hand-rolls `closeStores()`, `flushTelemetry()`, `flushAutoRecallMetadata()`, and four `drainXxxBackgroundTasks()` functions inline (lines 506-576). These are all 1:1 with `PluginSingletonState` properties.
  - `index.ts` also redefines `resolveGovernanceCommandContext` and `runCommandGovernanceAutomation` (lines 140-164) inline, then immediately inlines another copy of the same governance logic at lines 398-418 when `preferenceDistiller.enabled`. Both inline copies could live in `preference-distiller.ts` as exported helpers.
  - `index.ts:285-326` hand-builds an `LlmClient` from `api`, `config`, and `resolveEnvVars(...)` — logic that is already centralized in `plugin-singleton.ts:292-321` for the smartExtractor path. There is now a parallel LlmClient construction for the CLI that drift in different directions is easy.
- **Impact**: When the lifecycle or governance wiring changes, every `register()` body edit needs to scan 660 lines. The 15 destructured-but-`_`-prefixed properties are dead-in-this-function noise that exists only because the structure is monolithic. The duplicated LlmClient build means a future fix to one path (e.g. add oauth refresh, retry backoff) will be silently skipped on the other.
- **Proposed fix**: Move the per-registration wiring into smaller functions in `plugin-registration.ts` (the file is already imported at `index.ts:80`, and `registerGatewayMaintenance` lives there — extend the pattern).
  - Extract `buildShutdownTasks(state, api)` that returns the 6 functions (`closeStores`, `flushTelemetry`, `drainAutoRecallBackgroundTasks`, …) — they all take the singleton plus api, so move them next to `PluginSingletonState`.
  - Move `resolveGovernanceCommandContext`/`runCommandGovernanceAutomation` into `preference-distiller.ts` and import them.
  - Build the LlmClient for the CLI in a shared factory (e.g. `buildLlmClientFromConfig(config, api)`) so `plugin-singleton.ts` and `index.ts` use one path.
  - Keep only the orchestration / `WeakSet`-guarded idempotency / `registerService` block in `index.ts`. The destructure-then-discard pattern should go away once the consumers are imported lazily (only on first use).
- **CR-1..CR-10 status**: New issue. The CR review noted CR-2 (atomic write coverage), CR-8 (deferred vector index), CR-7 (audit queue drain) but did not call out the `register()` body itself as a structural problem.

---

### F7 — P2: Plugin singleton re-init guard relies on `_registeredApis`/`getSingletonState()` but has no idempotency for hot-reload of a different API instance

- **File:line**: `index.ts:65-95, 105-106`, `src/plugin-singleton.ts:88-101`.
- **Evidence**:
  - `index.ts:65`: `_registeredApis = new WeakSet<OpenClawPluginApi>()` — keyed by API instance. The comment at 64-65 says this fixes the "second register() call skips hook/tool registration for the new API instance" regression.
  - `index.ts:91-94`: if `_registeredApis.has(api)`, skip everything in `register()`.
  - `index.ts:105`: if `!getSingletonState()`, run `setSingletonState(_pluginStateFactory(api))`.
  - The risk: OpenClaw calls `register(api)` once per scope init. The **first** call builds the singleton; the **second** call with a different `api` sees the existing singleton and does not rebuild. But if a test or hot-reload constructs a *new* `api` while the old `api`'s hooks are still attached to the previous singleton, the new `api` will register tools against the OLD singleton's retriever/embedder/store.
  - `resetRegistration()` at `index.ts:763-768` is documented as a no-op (because WeakSets cannot be cleared). `__resetSingletonForTesting__` clears the singleton but **not** the WeakSet. So in tests, the WeakSet may still hold the previous API instance, and the next `register()` call with that same instance reuses the singleton factory that the test reset.
  - `plugin-singleton.ts:436-440`: a 5-minute `_pruneInterval = setInterval(...)` is created during init. It is wired to `_singletonState.sessionPruneInterval` so `stop` can clear it. But if `initPluginState()` is somehow called twice without `__resetSingletonForTesting__`, the first interval is leaked.
- **Impact**: This is a defense-in-depth concern. In normal OpenClaw flow the WeakSet guard is sufficient because OpenClaw owns the `api` lifecycle. The risk surfaces in tests, hot-reload, or any future "register plugin without restart" scenario. There is no async race because `_registeredApis.add(api)` and `setSingletonState(...)` are synchronous, but there is a *logical* race: if `register(api1)` is mid-execution when `register(api2)` fires, both could observe `_registeredApis` as having neither API yet and both proceed past the guard.
- **Proposed fix**: Either (a) serialize registration through an `async registerLock` queue, or (b) collapse the WeakSet + module-level state into a single `Map<OpenClawPluginApi, PluginSingletonState>` so the association is explicit and the "do I already have state for this api" check is exact. Add a tiny test in `test/` that constructs two APIs and asserts only one store is opened.
- **CR-1..CR-10 status**: Closely related to the CR-era "Phase 2 — Singleton state" introduction, but the idempotency story was never closed out in tests. New finding against current code.

---

### F8 — P2: Public re-export surface `src/tools.ts`, `src/store.ts`, `src/retriever.ts` is stable, but `store.ts` re-exports leaky abstractions

- **File:line**: `src/store.ts:52-71`, `src/retriever.ts:62-69`, `src/tools.ts:12-32`.
- **Evidence**:
  - `src/store.ts:54-67` re-exports `FULL_ENTRY_COLUMNS`, `LIST_ENTRY_COLUMNS`, `DEFAULT_SCALAR_INDEX_COLUMNS`, `MIN_VECTOR_INDEX_ROWS`, `escapeSqlLiteral`, `isExplicitDenyAllScopeFilter`, `buildScopeWhereClause`, `combineWhereClauses`, `prefixWhereClause`, `isVectorIndexType`, `isScalarIndexType`, `recommendedVectorPartitions`, `scoreLexicalHit`. Some of these are SQL composition primitives (`escapeSqlLiteral`, `combineWhereClauses`, `prefixWhereClause`) that "feel like" store-layer public API but are really LanceDB-SQL-construction utilities. Other modules that want to build a custom query (e.g. dashboard drill-down, compaction) can legitimately need them, but they are also the main attack surface for SQL injection regressions.
  - `src/retriever.ts:62-69` re-exports `RetrievalConfig`, `RetrievalContext`, `RetrievalResult`, `RetrievalDiagnostics`, `RetrieverLifecycleOptions`, `DEFAULT_RETRIEVAL_CONFIG`. These are used by `cli.ts`, `dashboard-server.ts`, and the tools. Stable and correct.
  - `src/tools.ts` (as noted in F1) re-exports ten `registerMemoryXxxTool` functions but only invokes three.
  - The most fragile surface is `src/store-sql-utils.ts` (line 233-254) where `resolveMemoryId()` lives but is named identically to a function in `src/tools-shared.ts`. The `resolveMemoryId` in `store-sql-utils.ts` returns `{raw, isFullId}`; the one in `tools-shared.ts` returns an async `ResolveMemoryIdResult` with `.ok/.id/.message/.details`. Different shapes, same name, different modules, both re-exported via `store.ts` (or accessible from it).
- **Impact**: The "public compatibility" contract documented in CLAUDE.md says `src/store.ts` and `src/retriever.ts` re-export types/utilities from focused helper modules, and that contract is honored — but `src/store-sql-utils.ts` exposes SQL composition primitives that are internal implementation detail. The two `resolveMemoryId` functions with different shapes are a footgun: a consumer who imports from `store.ts` gets one; from `tools-shared.ts` gets the other.
- **Proposed fix**:
  - Keep the type-only re-exports (MemoryEntry, MemorySearchResult, RetrievalConfig, …) — those are the real public surface.
  - Move SQL primitives (`escapeSqlLiteral`, `combineWhereClauses`, `prefixWhereClause`, `isVectorIndexType`, `isScalarIndexType`, `recommendedVectorPartitions`) out of `src/store-sql-utils.ts`'s public export list. They should be `internal` (no `export`) or live under a `src/internal/lancedb-sql/` directory that store.ts imports privately.
  - Rename one of the two `resolveMemoryId` functions to disambiguate (e.g. `parseMemoryIdPrefix` for the sync utility, keep `resolveMemoryId` for the async resolver in tools-shared). The two functions do semantically different things and the naming collision is going to bite.
- **CR-1..CR-10 status**: New issue. CR-5 touched category compatibility but not the SQL-utils re-export layer.

---

## What's working well

- **Dependency direction is acyclic at the level that matters.** `embedder.ts` only depends on `chunker.ts`, `embedding-cache.ts`, `logger.ts`. `store.ts` depends only on `smart-metadata`, `memory-categories`, `audit-log`, `file-utils`, `utils`, `logger`. `retriever.ts` depends on `store.ts` (type-only) and a handful of retriever-internal modules — no back-edge from store into retriever, embedder, or hooks. No circular `import` cycles were found across the 119 source files.
- **Plugin singleton drain choreography is solid.** `index.ts:733-749` and `plugin-singleton.ts:408-440` together implement a 12-step shutdown (clear deferred timers → drain startup tasks → flush access tracker → drain auto-recall tasks → flush auto-recall metadata → drain hook enhancement → drain auto-capture → drain reflection → flush telemetry → stop dashboard → stop auto-backup → close feedback loop → clear prune interval → flush stores → close stores). The CR-era work that landed in `docs/code-review-2026-06-28.md` lines 286-340 is genuinely load-bearing and well-organized.
- **`store-types.ts` / `store-sql-utils.ts` / `store-row-mappers.ts` / `lancedb-loader.ts` separation is clean.** The 2072-LOC `store.ts` is the integration point; the helpers are individually 100-300 LOC, focused, and free of dependency on each other. This is the model the rest of the hot files should follow.
- **Smart metadata corrupt-row observability (audit #2) is well-designed.** `src/smart-metadata.ts:33-52, 457-465` exposes both a process counter and a per-row `__corrupt` flag. The `getCorruptMetadataStats()` API at line 36 plus `onCorrupt` callback at line 343 is a tidy way to make silent data loss loud without coupling `parseSmartMetadata` to a logger.
- **Async-safety primitives in `store.ts` are explicit.** `serializedStoreContext` (line 106) + `batchStoreContext` (line 107) using AsyncLocalStorage; `_serialChain` reset when the queue drains (line 322); `flushWrites()` is a tail-chasing wait (line 333-339). The `runBatch`/`flushBatch` retry path even documents the "do NOT clear context buffer" rule (lines 207-220). The intent is correct even where the implementation is over-engineered (see F5).

---

## Appendix: notes that did not become findings

- **Empty catch blocks**: only three (`smart-extractor-dedup.ts:121`, `workspace-utils.ts:70`, `reflection-cli.ts:245`) plus two `.catch(() => {})` (`retrieval-stats.ts:75`, `auto-backup.ts:66`). Each is justified (LLM dedup defaulting to "create" on bad JSON, stat hook isolation, unlink-ENOENT cleanup). No additional error-handling finding needed.
- **Re-export shape**: `src/retriever.ts` is the cleanest of the three public surfaces. `src/store.ts` has the re-export-leak concern captured in F8; `src/tools.ts` has the dead-code concern captured in F1.
- **Hot files outside the top 3**: `src/embedder.ts` (1132 LOC), `src/dashboard-server.ts` (1229 LOC), `src/hook-enhancements.ts` (954 LOC), `src/auto-recall-hook.ts` (903 LOC), `src/feedback-loop.ts` (869 LOC). All are big but each is a single coherent concern (one external client, one HTTP server, one hook collection, one feedback loop). Not flagged.
- **`no-explicit-any` allowlist**: `eslint.config.js:39-55` lists eight files; the choice to keep the allowlist centralized is good. The largest user is `index.ts`, which is reasonable given its 660-line `register()` body. No change recommended; flagged only as part of F6 (if register() is decomposed, the `any` count drops with it).