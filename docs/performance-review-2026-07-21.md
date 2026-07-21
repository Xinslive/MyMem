# MyMem Performance & Operational Review — 2026-07-21

Reviewed against current `main` (HEAD `b6dd1ca`), covering hot-path latency, main-path stalls, memory pressure, and operational fitness. Items below are ranked with P0 leading. Severity reflects impact on the per-turn / per-recall hot path first; CLI/indexer issues are weighted lower.

## Top 8 Findings

### P0-1 — Auto-recall fires two **sequential** retrievals (general + reasoning strategy)
**File:** `src/auto-recall-hook.ts:513-538`, `src/retriever.ts:660-1011`
**Evidence:** The `before_prompt_build` hook issues `retrieveWithRetry(...)` for the general result set, awaits it to completion, then immediately issues a *second* `retrieveWithRetry(...)` for `reasoningStrategies`. The only difference between the two calls is `limit`, `candidatePoolSize`, and `overFetchMultiplier`; the query, signal, scope filter, and source are identical. Each retrieval itself does **embed + BM25 + vector + RRF + rerank + MMR + decay** (see `MemoryRetriever.hybridRetrieval`, lines 660–1011). With the default hard timeout of 20 s, two sequential calls can each approach the soft-degrade window; in the worst case they double total wall-time.
**Impact:** Adds roughly one full retrieval budget (embed ~50–250 ms + LanceDB hybrid ~30–300 ms + rerank ~150–800 ms) on **every auto-recall**. Order of magnitude: 200–1300 ms additional latency on the user-visible prompt-build path. In practice this often doubles `before_prompt_build` duration.
**Fix:**
- Run the two retrievals in parallel via `Promise.all([generalRetrieve, strategyRetrieve])` and join the results. The strategy pool is a strict subset of `enrichedByStrategy` filter logic so the dedupe later in lines 555–559 already tolerates duplicate IDs.
- Even better: have the retriever expose a single `retrieve({ includePatterns: true })` flag and union both pipelines internally — eliminates duplicated work in `metaObj` parsing, post-processing, MMR, and confidence scoring.
**Status:** **New issue** (not introduced by CR-1..CR-10).

---

### P0-2 — `recallQuery` is **re-embedded** on every recall even within the same session
**File:** `src/auto-recall-hook.ts:472-523`, `src/retriever.ts:550/771`, `src/embedding-cache.ts:33-95`
**Evidence:** The auto-recall hook builds `recallQuery` from `cachedRawUserMessage` or `event.prompt` and passes it through to `retriever.retrieve()`, which calls `embedder.embedQuery(recallQuery)` unconditionally (`retriever.ts:550` and `:771`). The `EmbeddingCache` *does* memoize by exact string (`embedding-cache.ts:46-51`), but only the exact same query text in the same `task` namespace hits. Slight punctuation/case differences common in conversation hooks (`" Deploy model"` vs `"deploy model"`) miss the cache. The inflight de-dup (`embedder.ts:765-779`) catches only truly simultaneous identical queries. Additionally, every retrieval re-issues the **same** query string twice — once for the general pool, once for the reasoning-strategy pool (P0-1) — even though the embedding is identical; the cache does save on embedding cost, but the parallel network round-trip cost in `embedder.embedMany`/`embedWithRetry` is paid once more.
**Impact:** Embedding API round-trip is on the critical path (no fast cache hit when there is a miss). `EMBED_TIMEOUT_MS = 3_000` (`concurrency-limiter.ts:5`) means a single cache miss can stall `before_prompt_build` by up to 3 s. Two requests per turn can serialize under the global embed concurrency gate (`GLOBAL_EMBED_CONCURRENCY_LIMIT = 10`, `concurrency-limiter.ts:7`).
**Fix:**
- Pass the already-embedded query vector through to *both* recall calls when P0-1's parallelization lands. The retriever already supports this for rerank (line 956 `if (!queryVector) throw ...`) but the embed call is duplicated.
- Add a tiny LRU on the most recent N normalized query strings per session to absorb the typical user prompt prefix drift ("hi can you…").
- For auto-recall, lower the maximum query length past a token budget (currently `autoRecallMaxQueryLength = 2_000` chars, `auto-recall-hook.ts:472`); many recall edges hit the embedding-API token cap with short models and trigger the chunking retry path.
**Status:** **post-CR regression** — CR-6 changed how stats are computed but did not touch the cache path; the cache itself is correct, but P0-1's duplicate path doubles the lookup cost.

---

### P0-3 — Long-lived singleton maps have **no byte-sized cap** and depend on a single 5-min pruning tick
**File:** `src/plugin-singleton.ts:408-440`, `src/config-utils.ts` (`pruneMapIfOver`)
**Evidence:** `SESSION_MAP_MAX = 500`; nine maps share one cap regardless of entry size. But several maps hold **string-heavy** values:
- `lastRawUserMessage` — full prompt text up to `autoRecallMaxQueryLength` (2 000 chars by default).
- `autoCaptureRecentTexts` — array of full message texts, kept `slice(-6)` per session (`auto-capture-hook.ts:187`).
- `reflectionByAgentCache` — array of reflection strings (`plugin-singleton.ts:70`).
- `recallHistory` — `Map<string, Map<string, number>>` grows one inner map per session; a long-lived daemon with thousands of distinct sub-agent sessions accumulates inner maps that each store every distinct recalled id (no eviction beyond the 500-session cap).

The single 5-minute `setInterval` runs against a process that may have never had a single idle moment — and it relies on `pruneMapIfOver`, which still needs to be verified to drop *by size or count* with sane ordered semantics.
**Impact:** Under sustained load the worst-case RSS contribution from process-local state is on the order of `9 × 500 × ~10 KB ≈ 45 MB`. Not catastrophic, but **monotonic over days until the next restart** if any map grows faster than the session cadence (e.g. `lastRawUserMessage` is per-conversation, not per-session).
**Fix:**
- Replace the single 500-cap with a per-map byte budget: ~256 KB for the text-heavy maps (`lastRawUserMessage`, `autoCaptureRecentTexts`, `reflectionByAgentCache`), count-based 4 096 for the rest.
- Use a finalizer for stale entries: an in-place LRU rather than a periodic sweep.
- Particularly important for `recallHistory` — see P1-3 below for the unbounded inner map.
**Status:** **post-CR regression** — the 5-min prune interval and 500 cap were added during the audit remediations; they are still insufficient against sustained load.

---

### P0-4 — `fuseResults` makes a **synchronous extra LanceDB round-trip** on every hybrid recall, gated on AbortSignal
**File:** `src/rrf-fusion.ts:38-52`, `src/store.ts:1245-1264`
**Evidence:** `fuseResults` (called from `hybridRetrieval:921`) calls `store.hasIds(ghostCheckIds)` to detect FTS-vector ghosts. This is `await`ed on the main recall path. `hasIds` is implemented as a synchronous loop over `METADATA_BATCH_CHUNK_SIZE = 200` (`store.ts:1251-1262`) — each chunk performs an `id IN (...)` SQL query through `this.table!.query().where().toArray()` and each call awaits LanceDB. For a typical 12-candidate recall, `ghostCheckIds` is small (often 0) so the call is cheap, but under `excludeInactive + overFetchMultiplier = 20`, the vector pool can hit `safeLimit*20 = 200` candidates (capped), and `fuseResults` may iterate the full set even when only the BM25 side is large. The cost is one extra `toArray()` per recall in the worst case.
**Impact:** Roughly 5–30 ms added to each auto-recall on local LanceDB, dominated by IPC + Arrow materialization on `>10K`-row datasets. Under sustained recall load this is direct main-path overhead.
**Fix:**
- Move the ghost check **after** the heavy scoring stage or perform it lazily for IDs that would otherwise affect the top-K (skip for IDs already present in the vector map — already done at `:41`). For the remaining BM25-only IDs, check only the top-3 BM25 entries; the rest can be deferred. Audit #15 is correct about ghosts being rare after FTS rebuild.
- For the common case where both vector and BM25 results are present and `excludeInactive` is true, `isMemoryActiveAt` already filtered everything inside `store.vectorSearch` / `bm25Search`; the extra `hasIds` round-trip is then redundant.
**Status:** **New issue** (introduced by the fix for FTS ghost entries — not part of CR-1..CR-10 audit log but added later as audit #15).

---

### P0-5 — Two **synchronous regex/JSON parses per candidate** on the recall hot path
**File:** `src/auto-recall-hook.ts:619, 653, 654`, `src/retriever.ts:570, 633, 939`, `src/smart-metadata.ts`
**Evidence:** Every recalled candidate has its metadata parsed inline during post-processing:
- `retriever.ts:570, 633, 939` — `parseSmartMetadata(r.entry.metadata, r.entry)` on every expired-check.
- `auto-recall-hook.ts:619, 653` — `parseSmartMetadata(...)` invoked again per candidate inside `governanceEligible` filter and `preBudgetCandidates` map.
- Each `parseSmartMetadata` does `JSON.parse` of the metadata blob plus the full lifecycle/smart-metadata decoding.

Two or three times over the same rows in the same call. There is no `_parsedMeta` cache reuse across stages — `entry._parsedMeta` is populated by `store-row-mappers.ts:40` but ignored in `parseSmartMetadata` lookups in `auto-recall-hook.ts:619`.

A separate issue: `parseSmartMetadata` on the hot path uses `entry.metadata` (the raw JSON string) but several call sites do `_parsedMeta ?? parseSmartMetadata(...)`, which is fine; the regression is in the retrieval loop in `applyPostProcessingPipeline` where `temporal/scoring.ts` -> `learning-memory.ts` each call into smart-metadata.

**Impact:** With 12 candidates, ~24–36 `JSON.parse` calls per recall; each parse of a typical entry metadata (~500 bytes) costs ~5–50 µs. Total: ~0.1–2 ms per recall. Under load, this is also GC pressure.
**Fix:**
- Lift `_parsedMeta` once at the retrieval boundary (`hybridRetrieval`'s `mapped` step already constructs `RetrievalResult` from `unexpired`; copy `entry._parsedMeta` there).
- Add a lazy property descriptor so `_parsedMeta` is populated on first read and then shared across all callers in the same tick.
**Status:** **post-CR regression** — pre-CR-6 workarounds scanned metadata in stats; while CR-6 reduced stats scans, the inline `parseSmartMetadata` calls remained in retriever/post-process and were not addressed by CR-8 (deferred vector index).

---

### P0-6 — Lexical fallback `LIMIT + 500` materializes **rows just to filter in JS**
**File:** `src/store.ts:1458-1513` (`lexicalFallbackSearch`)
**Evidence:** When FTS is unavailable or empty, `lexicalFallbackSearch` fetches `limit + 500` rows (`searchQuery.limit(limit + 500).toArray()` at `:1477`) with all 7 entry columns (`id`, `text`, `category`, `scope`, `importance`, `timestamp`, `metadata`). It then runs `tokenSetForSearch` and `scoreLexicalHitPreTokenized` per row in JS. For larger `limit` (recalls can request `limit: 8` x over-fetch, so up to ~205 rows; but in CLI `/reflection` paths the limit is 100–200) this materializes arbitrary rows and parses each metadata inline (the `mapRowToMemoryEntry` mapping parses again here).
**Impact:** Direct stall of the fallback path. Unlike the hybrid path, this path also evaluates softCutoff/JIT/eval surfaces in JS. On a 50 K-row table, the over-fetch pulls everything that matches the scope WHERE — a full scan if no scalar index. Estimated cost: 30–200 ms per call on cold disk; worse on large DBs.
**Fix:**
- Move the lexical filter into LanceDB SQL using `ngrams` UDF or a stored scalar index on `LOWER(text)` plus an `instr(...)` prefilter to keep the candidate set small.
- Cache tokenization across calls (the module already does for `tokenSetForSearch`) — the bug is that `normalizeSearchText` is called per row in the loop, and `tokenSetForSearch(candidate.normalized)` is hit on every tokenization. With the existing `tokenSetCache`, hits are good — but `tokenSetCache` uses string LRU which is now unbounded (good), but the 4 096 character cap (`store-sql-utils.ts:90`) excludes most long-form memory texts.
**Status:** **New issue** — FTS is the dominant path; lexical fallback is intended for environments without FTS, but its cost is much higher than expected.

---

### P0-7 — JSONL append hot path: **no fsync, no queuing on `workspace-utils.ts`**
**File:** `src/workspace-utils.ts:179-207` (`createAdmissionRejectionAuditWriter`), `src/dashboard-server.ts:mdMirror`
**Evidence:** The audit-logger (`audit-log.ts:62-71`) is correctly serialized via `writeTail = this.writeTail.then(...)` and lives in a queue. By contrast:
- `mdMirror` at `workspace-utils.ts:165-169` calls `appendFile` with no queue, no serialization. Every `store()` call that triggers mdMirror awaits its own appendFile and, depending on the call path, blocks the caller.
- `createAdmissionRejectionAuditWriter` at `:195-206` calls `appendFile` per rejected candidate inside the `onAdmissionRejected` async callback (`plugin-singleton.ts:326-333`). When the smart-extractor rejects N candidates in parallel, N concurrent `appendFile` calls race on the same file. `node:fs/promises.appendFile` does open+write per call and is not atomic across interleaved writers.
**Impact:** Interleaved writes from concurrent rejections can tear lines; simultaneous `appendFile` calls also defeat the OS page-cache coalescing on macOS (`KIOXIA` USB SSDs are particularly bad at small random writes — even on the host-side `/Volumes/KIOXIA`). Latency is unbounded — a single fs stall of any kind starves all inflight memories.
**Fix:**
- Wrap both mdMirror and admission-rejection writers with the same `withWriteQueue` pattern as `telemetry.ts:63-81`.
- For mdMirror specifically, batch by date into a single `appendFile(''.join(...lines))` to amortize syscall cost; the current path is per-memory and per-store-call.
**Status:** **post-CR regression** — CR-2 introduced atomic writes for several JSONL paths but missed mdMirror and admission audit. CR-7 introduced a queue for the mutation audit, not for mdMirror/admission.

---

### P1-8 — `cli.ts` re-embed path pulls **all rows into memory** before filtering
**File:** `cli.ts:932-944`, `cli.ts:920-1010`
**Evidence:** `mymem doctor --reembed` opens the source table, builds a `query().select([...]).limit(limit)`, then `await query.toArray()` and runs `.filter().filter()` in JS. This is fine for the default `--limit` paths, but the CLI also serves a `--rows no limit` case (line 942 has no implicit `limit(limit)` until `if (limit)` check). For real production databases (10 K – 1 M rows) this materializes the full table before any filter is applied. The follow-up loop in lines 965–1010 then calls `context.embedder.embedBatchPassage(texts)` per batch.
**Impact:** Worst case, `cli doctor --reembed` materializes a multi-GB Arrow result, hangs the host process, and may exit with OOM on machines with < 16 GB RAM.
**Fix:**
- Page the iteration using `.limit(N).offset()` or by `timestamp` window; the store already has `findListWindowLowerBound` for the SQL approach. Or stream via `for await (const rows of table.query().limit(BATCH_SIZE)) { ... }` and write each batch as it lands.
- Drop the unused `_batchBuffer` and related state from `MemoryStore` instance if `--reembed` is its only consumer (memory/disk).
**Status:** **New issue** — not part of CR-1..CR-10. The CLI was not exercised in the audit hot-path loop.

---

## What's working well

- **CR-6 stats() regression fix holds.** `countRowsWithFilter` with scope/category predicates, plus the bounded `STATS_SCOPE_SAMPLE_LIMIT = 500` (`store.ts:112`), keeps `stats()` O(N) without O(N×row). Confirmed at `store.ts:1605-1689`.
- **CR-8 deferred vector index.** `maybeCreateDeferredVectorIndex` (`store.ts:607-633`) is gated by `DEFERRED_VECTOR_INDEX_RETRY_COOLDOWN_MS = 5 min` so a single failing index build does not stall every write at the gate. `countRows()` is the cheap canary. Good.
- **Hybrid parallel search.** `hybridRetrieval:734-852` correctly parallelizes BM25 + vector via a shared `Promise.allSettled`, then races both against a soft-degrade timer. This is one of the better concurrent patterns in the codebase.
- **Tier-maintenance background offload.** `retriever.ts:1132-1146` and `auto-recall-hook.ts:747-753` use `trackBackgroundMetadataWrite` and `runTierMaintenance` (background), so recall hot-path doesn't block on LanceDB updates.
- **`recordAccess` access-tracker.** `access-tracker.ts:385-470` (`doFlushBatch`) reads once, batches writes, and uses `updateBatchMetadata` — N+1 avoidance verified.
- **LRU embedding cache.** `embedding-cache.ts:33-95` is correctly bounded; short-text raw key + long-text hash key; per-key LRU via Map.delete+set. `MAX_BATCH_DEDUP_SIZE = 50` guards the O(N²) shape explicitly (`batch-dedup.ts:71-72`).
- **Reflection/main-store isolation.** `assertWritableEntryCategory` (`store.ts:353-368`) hard-rejects `category === "reflection"` on the main store; the reflection store is initialized with `allowReflectionCategory: true` (`plugin-singleton.ts:230-234`). Boundary is enforced at the write site, not just at reads. Cross-contamination is not possible via the conventional path.
- **Cancellation in `retrieveWithRetry`.** `auto-recall-hook.ts:496-498, 512, 524` propagates `signal.aborted` through every await, including between vector and rerank. Good fidelity.

---

## Suggested order of operations

1. **P0-1 + P0-2 jointly**: rewire auto-recall to one retrieval that exposes `includeReasoningStrategies: true`, embed the query once, and parallelize at the strategy level. Single audit entry, captures both halves of the latency cliff.
2. **P0-7**: gate `mdMirror` and `admissionRejection` writers through `withWriteQueue`. ~50 LOC change, immediate durability + latency fix.
3. **P0-4**: drop the sync `hasIds` call from `fuseResults`; rely on `isMemoryActiveAt` filtering already done in `vectorSearch` / `bm25Search`.
4. **P0-3 / P1-8**: add per-map byte budgets in `initPluginState`; page the CLI reembed path. Both require only shape changes, not algorithmic ones.
5. **P0-5 / P0-6**: share `_parsedMeta` along the retriever; lexical fallback to SQL prefilter. Lower priority because the hot-path avoidance is the higher win.

## Methodology notes

- Files reviewed in depth: `src/auto-recall-hook.ts` (entire file), `src/retriever.ts` (entire file), `src/store.ts` (lines 100–2072), `src/embedder.ts` (full), `src/embedding-cache.ts` (full), `src/batch-dedup.ts` (full), `src/smart-extractor-dedup.ts` (full), `src/audit-log.ts` (full), `src/telemetry.ts` (full), `src/access-tracker.ts` (full), `src/workspace-utils.ts` (full), `src/retrieval-stats.ts` (full), `src/retrieval-trace.ts` (full), `src/store-sql-utils.ts` (full), `src/plugin-singleton.ts` (full), `src/reflection-store.ts` (full), `src/auto-capture-hook.ts` (full), `cli.ts` (1–1298 sampled), `benchmark/run.ts` (full), `src/concurrency-limiter.ts` (full), `src/retriever-utils.ts` (full), `src/query-expander.ts` (full), `src/rrf-fusion.ts` (full).
- Latency numbers are order-of-magnitude estimates from reading the call graph; not benchmarks. Run `npm run benchmark` with `--scenario retrieval --rows 2000 --iterations 20 --fail-on-regression` after fixes to confirm before/after.
- Not reviewed: `src/dashboard-server.ts` (≈42 KB), `src/hook-enhancements.ts` (≈39 KB), `src/feedback-loop.ts` (≈33 KB), `src/smart-metadata.ts` (≈31 KB), `src/intent-analyzer.ts`, `src/learning-memory.ts`. These are secondary hot-path contributors and may surface in a follow-up pass.
