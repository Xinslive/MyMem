# Test Coverage Gap Analysis — 2026-07-21

## Scope & method

Grounded in git history of commit `b6dd1ca` ("chore: slim down test suite", 2026-06-28), which
deleted **115 files / 32,920 lines** of test + CI-manifest infrastructure. Analysis cross-references
the deleted files against the CR-1..CR-10 fix log in `docs/code-review-2026-06-28.md` and the
5 surviving tests. Source-side invariants were verified to still exist (functions not deleted, only
their tests). No source files were modified.

**Surviving safety nets**

- `test/capture-detection.test.mjs` — `shouldCapture` / `detectCategory` / `sanitizeForContext`
- `test/config-utils.test.mjs` — `resolveEnvVars`, `parsePositiveInt`, `clampInt`
- `test/runtime-write-policy.test.mjs` — static-source guard: main-memory `.store(` only on allowed paths; reflection persistence isolated
- `test/plugin-manifest-regression.mjs` — schema defaults + **verifies service-stop flushes the store audit log** (partial CR-7)
- `test/cli-smoke.mjs` — CLI wiring / scope flags
- Plus `npm run typecheck` and `npm run lint` (zero warnings; `no-explicit-any` = error → covers CR-10).

---

## 1. Highest-risk gaps first (lead)

The slim-down is defensible for edge-case and internals tests, but it removed **every focused
regression test for the P0/P1 security & data-integrity findings** from the June audit. The source
fixes still exist, but nothing now pins their behavior — a future refactor of the sanitizer, scope
SQL, or admission path would pass typecheck + lint + all 5 smoke tests while silently regressing a
known-exploited invariant.

| Rank | Uncovered invariant | Finding | Why it's high-risk |
|------|--------------------|---------|--------------------|
| 🔴 1 | **Secret redaction on all write paths** (`sanitizeMemoryWriteText`, used by store/update/mdMirror/import + admission audit + LLM/dedup debug logs) | CR-1, CR-4, CR-9 | Pure string logic → a regex/ordering change leaks API keys/bearer tokens into persisted memory, JSONL audit, or logs. Lint/typecheck cannot detect a semantic redaction miss. |
| 🔴 2 | **Legacy `scope IS NULL` ACL semantics** — `NULL` rows visible only when `global` is explicitly in the scope filter (`store-sql-utils.ts:42`) | CR-3 | Cross-scope data leak. A one-token change to the SQL condition (`store-sql-utils.ts`) is invisible to every remaining test. This is the single most dangerous untested line. |
| 🟠 3 | **Admission rejection audit redaction** (`sanitizeAdmissionRejectionAuditEntry`, `admission-control.ts:95`) + `0o600` file perms | CR-1 | Rejected candidates + conversation excerpts are persisted; the redaction wrapper is one function call deep and easy to bypass in a refactor. |
| 🟠 4 | **Deferred vector index cooldown after failure** (last-error/fail-count/next-retry) | CR-8 | Regression = retry storm on every write (perf + log spam). No remaining test; not observable statically. |
| 🟡 5 | **Store audit-log queue drain semantics** (init-race queueing + flush-waits-for-in-flight) | CR-7 | Partially covered: `plugin-manifest-regression.mjs` asserts service-stop *calls* `flushAuditLog`, but not the queue/drain ordering the deleted `store-audit-log.test.mjs` pinned. Race-condition class → invisible to lint/typecheck. |

CR-2 (atomic writes for markers/tokens/audit), CR-5 (six-category convergence — partly guarded by
`runtime-write-policy` + `capture-detection`), and CR-6 (`stats()` count-query, perf-only) are lower
priority: CR-5 has indirect coverage, CR-6 is performance, CR-2 is crash-only.

---

## 2. Removed-test → coverage map

Legend for action: **KEEP** = acceptable to leave dropped; **SMOKE** = re-add one minimal
regression; **DOC** = record as known-accepted risk.

### Critical invariants (security / data integrity / lifecycle)

| Removed test | Covered | Risk if regressed | Action |
|---|---|---|---|
| `admission-rejection-audit-redaction.test.mjs` | CR-1 secret redaction of persisted rejected candidates/excerpts + debug logs | **Secret leak to disk** | SMOKE (see Plan #1, bundle) |
| `manual-write-redaction.test.mjs` | CR-4 redaction on store/update/mdMirror/JSON+MD import + return preview | **Secret leak to store** | SMOKE (Plan #1) |
| `smart-extractor-handler-redaction.test.mjs` | CR-9 redaction in extractor handler previews | Secret echo in logs | SMOKE (Plan #1) |
| `scope-null-isolation.test.mjs` | CR-3 NULL-scope legacy ACL | **Cross-scope data leak** | SMOKE (Plan #2) |
| `scope-access-undefined.test.mjs`, `store-empty-scope-filter.test.mjs`, `clawteam-scope.test.mjs`, `smart-extractor-scope-filter.test.mjs` | scope filter edge cases | Scope leak edges | DOC (Plan #2 covers core) |
| `store-audit-log.test.mjs` | CR-7 audit queue/drain/flush + no-memory-text | Audit loss / race | SMOKE (Plan #3) |
| `vector-integrity.test.mjs`, `update-consistency-lancedb.test.mjs` | vector/text consistency on update | Corrupt vectors | DOC |
| `cross-process-lock.test.mjs`, `file-lock-timeout.test.mjs`, `lock-recovery.test.mjs`, `maintenance-state-atomic.test.mjs` | proper-lockfile / atomic maintenance (CR-2 adjacent) | Corruption under concurrency | DOC (hard to smoke-test cheaply) |
| `is-latest-auto-supersede.test.mjs`, `memory-update-supersede.test.mjs`, `temporal-facts.test.mjs`, `temporal-awareness.test.mjs` | supersede / temporal validity lifecycle | Stale/duplicate facts surface | DOC |
| `store-serialization.test.mjs`, `store-write-queue.test.mjs`, `flush-batch.test.mjs`, `migrate-legacy-schema.test.mjs` | serialization / write queue / migration | Data loss on migrate | DOC |

### Edge-case tests (specific behaviors / error paths) — acceptable to drop

`access-tracker*.test.mjs`, `auto-recall-abort-regression`, `auto-recall-query-length`,
`cjk-recursion-regression`, `embedder-*` (cache/lru/abort/batch/error-hints),
`retriever-*` (graceful-degradation/rerank-fallback/rerank/tag/decay/utils-abort),
`query-expander`, `rrf-fusion`, `mmr-diversity`, `retrieval-trace`, `intent-analyzer`,
`preference-*`, `learning-memory`, `feedback-loop`, `session-*`, `hook-*`,
`smart-metadata*`, `strip-envelope-metadata`, `recall-text-cleanup`, `governance-metadata`,
`nvidia-nim/llm-*/oauth-*` provider profiles, `issue-*`, `resolve-env-vars-array`
(core covered by `config-utils`). → **KEEP dropped.**

### Redundant / internals / infra — clearly fine to drop

`*-e2e.mjs` (functional/context/closed-loop/openclaw-host), `dashboard-server.test.mjs`,
`telemetry-and-benchmark`, `recall-eval`, `sync-plugin-version`, `store-native-esm-load`,
`store-sql-utils-token-cache`, `mdmirror-fallback-dir`, `extraction-prompts`,
`memory-doctor/explain/compactor/upgrader-diagnostics`, `memory-governance-tools`,
`gateway-maintenance`, `import-markdown`, `workflow-fork-guards`, `concurrency-limiter`,
plus deleted CI infra (`run-ci-tests.mjs`, `verify-ci-test-manifest.mjs`). → **KEEP dropped.**

---

## 3. High-risk modules now at ZERO direct coverage

- `src/memory-write-sanitizer.ts` — the linchpin of CR-1/CR-4/CR-9; imported by 10+ modules; **no test.**
- `src/store-sql-utils.ts` — `buildScopeWhereClause` / NULL-scope ACL; **no test.**
- `src/admission-control.ts` — `sanitizeAdmissionRejectionAuditEntry` + rejection persistence; **no test.**
- `src/store.ts` — audit queue/drain, deferred vector index cooldown (CR-7/CR-8); only indirectly touched.
- `src/retriever.ts` (~large orchestration) — RRF/temporal/rerank/MMR all untested; acceptable (behavioral, non-security) but note the breadth.

---

## 4. Static safety-net adequacy

Lint + typecheck reliably catch: type errors, unused vars, `any` creep (CR-10 fully covered), and
gross API-shape breaks. They **cannot** catch the classes of bug that the deleted P0/P1 tests
guarded:

- **Runtime string-semantic bugs** — a redaction regex that stops matching a secret shape still type-checks (CR-1/4/9).
- **SQL/ACL logic bugs** — flipping/removing the `scope IS NULL` guard is a valid string change (CR-3).
- **Race conditions & ordering** — audit-queue drain, flush-waits-for-in-flight (CR-7), lock recovery.
- **Integration/wiring drift** — sanitizer no longer called on a write path; cooldown not honored (CR-8).

Conclusion: static analysis is adequate for maintainability but **insufficient for the security and
data-integrity invariants**. The 3 highest-risk gaps (redaction, scope ACL, admission audit) are all
pure-logic and cheaply testable, which is exactly where a minimal regression test earns its keep.

---

## 5. Minimum viable regression test plan (3 highest-leverage, +2 optional)

Respecting the AGENTS.md philosophy — these are smoke-level, single-file, and target *only*
security/data-integrity invariants, not behavior coverage. Register each in
`scripts/ci-test-manifest.mjs` (the manifest verifier was itself deleted; re-adding it is a
prerequisite, or run these directly with `node --test`).

**1. `test/write-redaction-smoke.test.mjs`** *(covers CR-1 + CR-4 + CR-9, the top gap)*
Target invariant: no secret string survives any write/audit/log path.
~5 lines: feed a payload containing `sk-...`, `Bearer ...`, and a high-entropy token through
`sanitizeMemoryWriteText`, `sanitizeAdmissionRejectionAuditEntry`, and one `mymem_store` path;
assert output `doesNotMatch` each secret and `match`es `[REDACTED]`. One consolidated file replaces
the three deleted redaction tests.

**2. `test/scope-null-isolation.test.mjs`** *(covers CR-3 — the single most dangerous line)*
Target invariant: `scope IS NULL` legacy rows are visible only when `global` is in the scope filter.
~5 lines: seed a null-scope row; assert `getById`/`list`/`vectorSearch`/`stats` return empty for
`["agent:main"]` and non-empty for `["global"]`. Restore the deleted 38-line file nearly verbatim —
highest value-per-line of any test here.

**3. `test/store-audit-drain.test.mjs`** *(covers CR-7 beyond the current manifest check)*
Target invariant: audit entries queued during init/flush are drained, contain no memory text.
~5 lines: log a mutation before enable + during flush; `await flush`; assert both appear in order and
`JSON.stringify(entries)` does not contain the memory body text.

**Optional 4. `test/deferred-vector-index-cooldown.test.mjs`** *(CR-8)*
Assert that a forced index-build failure records last-error/fail-count and skips rebuild within the
cooldown window (spy on build calls). Perf/reliability, not security — add only if the index path is
touched again.

**Optional 5. `test/atomic-marker-write.test.mjs`** *(CR-2)*
Assert marker/token/audit files are written via temp+rename (no truncated file on simulated partial
write). Crash-only risk; lowest priority.

---

## 6. What's working well (the deliberate trade-off)

- The slim-down was **surgical about keeping the right smoke tests**: config parsing, capture
  detection, the write-policy source guard, manifest defaults, and CLI basics are exactly the
  "does the plugin wire up and not write to the wrong store" invariants that catch the most common
  breakage per line of test.
- `runtime-write-policy.test.mjs` is a clever, low-maintenance **static-source assertion** that guards
  the main-memory/reflection boundary without heavy fixtures — high leverage for a personal project.
- CR-10 (`no-explicit-any` → error) is genuinely and permanently covered by lint; re-adding a test
  would be redundant. Correct call.
- `plugin-manifest-regression.mjs` already retained a targeted check that service-stop flushes the
  audit log — evidence the trim was intent-driven, not indiscriminate.
- Typecheck + zero-warning lint + 5 green smokes is a **reasonable floor** for a single-maintainer
  repo. The only genuinely uncomfortable gaps are the 2–3 pure-logic security invariants above, and
  each can be re-pinned in a single ~40-line file — fully compatible with the "unless a bug truly
  needs a focused regression file" philosophy, treating the June audit's exploited findings as
  exactly that class of bug.
