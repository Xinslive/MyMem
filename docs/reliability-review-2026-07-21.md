# MyMem Reliability & Lifecycle Review — 2026-07-21

This review audits the post-CR shutdown-drain hardening work documented in
`docs/code-review-2026-06-28.md` (commits `14e67f3`, `a81e37b`, `ea8bd78`,
`b476aad`). The plugin singleton now wires `PluginSingletonState.*BackgroundTasks`
plus drain helpers in `index.ts:733-750`, and a wide array of
`close()`/`flush()`/`stop()` methods has been added across
`MemoryStore`, `AuditLogger`, `TelemetryStore`, `AccessTracker`, `AutoBackup`,
`FeedbackLoop`, `AutoRecallMetadataAccumulator`,
`RetrievalStatsCollector`. The test suite was also trimmed to smoke-only in
commit `b6dd1ca`.

Scope of this review: P0/P1 reliability regressions the CR work either
introduced, partially fixed, or failed to cover, plus any new issues visible in
the current HEAD.

---

## Top findings (ranked)

### P0-1 — `feedbackLoop.close()` writes to a store that has already drained
**File**: `index.ts:746-748`
**Post-CR regression**

```ts
if (feedbackLoop) await feedbackLoop.close();   // <-- may write lessonStore.update / lessonStore.store
stopSessionPruneInterval();
await closeStores();                            // <-- flushWrites → flushAuditLog → table.close()
```

`FeedbackLoop.close()` (`src/feedback-loop.ts:347-356`) awaits
`drainActiveTasks()` (which may include in-flight `runFeedbackDrainCycle()` and
`runPriorAdaptationCycle()`) and then calls
`flushRejectionMemoryBufferToFile()`. The drain cycles internally call
`lessonStore.list / update / store` (`src/feedback-loop.ts:537, 563, 594`),
i.e. `MemoryStore.update` and `MemoryStore.store`.

The lifecycle order in `index.ts:733-748` runs `feedbackLoop.close()` **before**
`closeStores()`. As long as both are awaited in sequence this is fine. However
`flushRejectionMemoryBufferToFile` is *unawaited* within the try block of
`flushActiveTasks` only by virtue of `await this.drainActiveTasks()`; but it is
also awaited in `close()`:

```ts
async close(): Promise<void> {
  this.dispose();
  await this.drainActiveTasks();
  await this.drainRejectionAuditWrites();
  const { dbPath, admissionConfig } = this.runtimeContext;
  if (dbPath && admissionConfig) {
    const filePath = resolveRejectedAuditFilePath(dbPath, admissionConfig);
    await this.flushRejectionMemoryBufferToFile(filePath);
  }
}
```

So the in-memory rejection buffer flush is *after* the store is still alive,
which is correct. **However**, the more subtle issue is the interaction with
`stopSessionPruneInterval()` — that runs between `feedbackLoop.close()` and
`closeStores()`, but `stopSessionPruneInterval` does not interact with the
store. The real risk is a different one:

`activeBackups` (`src/auto-backup.ts:26`) holds active backup promises that may
finish **after** `autoBackup.stop()` resolves but **before** `closeStores()`.
`runBackupOnce` (`src/auto-backup.ts:28-74`) calls `store.list(...)` (a read).
If a backup's `store.list` is in-flight at the moment `MemoryStore.close()`
runs, the call lands on a closed table and throws.

The lifecycle **does** drain active backups first (`await autoBackup.stop()` →
drains `activeBackups`), so the `await` covers it — but the ordering of the
`autoBackup.stop()` body is:

```ts
stop() {
  if (initialBackupTimer) { clearTimeout(initialBackupTimer); initialBackupTimer = null; }
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  return drainActiveBackups();
}
```

This is correct: timers cleared first, then drain. ✓

**Actual issue surfaced by this ordering**: the **session prune interval** is
cleared (`stopSessionPruneInterval()`) but its in-flight iteration is not
awaited. If prune is currently running `pruneMapIfOver` against
`recallHistory` or `autoCaptureSeenTextCount`, that iteration is synchronous so
this is fine. Not a finding.

The **real** ordering issue is the comment on the lifecycle itself:
`feedbackLoop.close()` may take several seconds (LLM worthiness call,
`learnPreventiveLesson` doing store reads/writes). If the host invokes `stop()`
and the user immediately restarts the plugin, the new instance starts while the
old `FeedbackLoop.close()` is mid-store-write. There is no instance fencing —
the `PluginSingletonState` `_singletonState` is null'd by the singleton reset,
but in-process shared resources (global `writeQueues`, `pendingAppends` from
`telemetry.ts:55-56`, `_pendingRecordHooks` in `RetrievalStatsCollector`) are
process-global and survive the singleton reset. A new singleton instance
immediately appending to the same JSONL will interleave with the old
drain's tail. This is a **process-global state** leak across hot-reloads.

**Impact**: Hot-reload or repeated `register()` calls (which the singleton
fences via `_registeredApis: WeakSet<OpenClawPluginApi>` at `index.ts:65`) can
share `telemetryStore.writeQueues` (file path is the same) and the
`RetrievalStatsCollector._pendingRecordHooks` is per-instance so OK; but the
audit log's `writeTail` (`src/audit-log.ts:36`) is per-`AuditLogger`, and the
store instance is also re-created, so on hot-reload the OLD store's `flushWrites`
runs while the NEW store has begun `_serialChain` writes. They share the same
underlying LanceDB file but different `MemoryStore` instances, so `runWithFileLock`
serialization is still correct per file lock — but two stores writing to the
same file means duplicate audit entries (one from each `AuditLogger`) and
double counting.

**Proposed fix**:
- Move `feedbackLoop.close()` to happen **after** `closeStores()` only if you
  verify it does no further store writes; otherwise keep current order but
  add an instance fence (e.g. tag each `MemoryStore` with a generation number,
  reject writes from older generations).
- For the global `telemetryStore.writeQueues`: pass an instance token through
  `flushJsonlWrites` so old flushes from a replaced store do not block a new
  instance.

---

### P0-2 — `AccessTracker` retry uses synchronous event-loop ticks that can race with `close()`
**File**: `src/access-tracker.ts:278-353`, `index.ts:737`
**Post-CR regression**

`AccessTracker.close()` (`src/access-tracker.ts:311-325`) loops
`for (let attempt = 0; attempt <= this._maxRetries && this.pending.size > 0; attempt++) { await this.flush(); }`.
`flush()` (`src/access-tracker.ts:278-304`) awaits any in-flight `flushPromise`
then recursively calls itself if `pending.size > 0` after the in-flight flush
returns. This means close() correctly drains pending writes within retry bounds.

But `destroy()` (`src/access-tracker.ts:330-353`) — the older, *synchronous*
close — is **still exposed** and never called by the lifecycle. It is dead
code, but its existence is misleading: the CR work replaced `destroy()` with
`close()` but left `destroy()` in the public API.

The actual P0 here: `AccessTracker.flush()` races with the debounce timer.
`resetTimer()` (`src/access-tracker.ts:503-510`) schedules
`setTimeout(() => void this.flush(), debounceMs)`. During shutdown:
1. `close()` calls `clearTimer()` (line 312).
2. `close()` enters the retry loop calling `await this.flush()`.
3. **A** pending `setTimeout` that already fired but whose `flush()` promise
   hasn't been `add`ed to `flushPromise` is impossible (the timer callback is
   just `void this.flush().catch(...)`; the flush is then in the `flushPromise`
   path).
4. But: `this.debounceMs` is captured at construction; if the timer fires
   after `clearTimer()` is called but its microtask is queued first, the timer
   callback runs and calls `this.flush()`. The flush then races with the
   `flushPromise` chain from `close()`'s loop. Both paths enter the body —
   `flushPromise` is set to the *first* flush; the second caller awaits the
   first and then loops: `if (this.pending.size > 0) return this.flush();`.
   This is safe.

But the `clearTimer()` check is non-atomic: `clearTimeout(this.debounceTimer)`
is synchronous and JS event loop is single-threaded, so this is **fine** — but
only if the timer hasn't fired. If it has fired but the microtask hasn't run
yet, `clearTimeout` won't help; the queued microtask will still call
`this.flush()`. This is actually **safe** because both call paths converge on
the same `flushPromise` chain. ✓

**Actual P0 issue**: `close()` only retries `_maxRetries` times (5). If the
store is in a transient failure state during shutdown (e.g., LanceDB mid-commit),
all 5 retries fail and the last pending batch is **dropped**:

```ts
async close(): Promise<void> {
  this.clearTimer();
  try {
    for (let attempt = 0; attempt <= this._maxRetries && this.pending.size > 0; attempt++) {
      await this.flush();
    }
  } finally {
    if (this.pending.size > 0) {
      this.logger.error?.(
        `access-tracker: close dropping ${this.pending.size} pending writes after shutdown retries`,
      );
    }
    this.clearState();
  }
}
```

This matches the fix log ("AccessTracker close 重试 drain" — commits already
implemented bounded retry). The trade-off is intentional: prefer dropping
access-count writes over blocking shutdown indefinitely. Not a finding per se,
but the **error log** is the only signal an operator has that the last N
access-counts were lost. No counter is incremented, no metric is exposed for
the dashboard.

**Impact**: Manual recall access counts for the last batch of memories (the
ones users cared enough to invoke `mymem_recall` for) may be silently dropped on
shutdown. Affects `recall-suppression`, `LearningMemory`, decay reinforcement.

**Proposed fix**:
- Track a `droppedOnShutdownCount` counter and surface it via
  `AccessTracker.getStatus()` and the dashboard health panel.
- Consider persisting the last failed batch to a small JSONL "recovery" file
  so the next start can replay it.

---

### P0-3 — `_signalIds: WeakMap<AbortSignal, number>` in `Embedder` grows unbounded across long-running process
**File**: `src/embedder.ts:177-179`, `744-754`
**Post-CR regression (new issue)**

```ts
private readonly _signalIds = new WeakMap<AbortSignal, number>();
private _nextSignalId = 1;
```

Each `embedWithInflight` call does:

```ts
const inflightKey = this.inflightKey(text, task, signal);
private inflightKey(text: string, task?: string, signal?: AbortSignal): string {
  const cacheKey = this._cache.key(text, task);
  if (!signal) return cacheKey;
  let signalId = this._signalIds.get(signal);
  if (!signalId) {
    signalId = this._nextSignalId++;
    this._signalIds.set(signal, signalId);
  }
  return `${cacheKey}:signal:${signalId}`;
}
```

`WeakMap` semantics ensure entries are GC'd when the `AbortSignal` is
unreferenced. However:

1. `AbortSignal` instances created by `AbortController` and immediately used as
   the `signal` arg of an `embedder.embedQuery/embedPassage` call are typically
   not held by anyone after the call returns. **If** the call is mid-flight,
   the signal is kept alive by the `inflightKey` map value (the promise
   reference is held, which holds the signal).

2. **The `_signalIds` WeakMap keys are `AbortSignal`s, not `Promise`s.** Once
   the embed returns, the signal can be GC'd and the WeakMap entry is
   collected. ✓

3. But: when the embedder is the `retriever.embedQuery` call site, the signal
   is the **outer** auto-recall signal (`retriever.ts:771`), which is held by
   the auto-recall timeout controller. That controller is created in
   `auto-recall-hook.ts:468` and lives only for the lifetime of the
   `before_prompt_build` hook invocation. After hook returns, the controller is
   GC'd, signal is GC'd, WeakMap entry is GC'd. ✓

4. **The `_inflightSingle: Map<string, { promise; createdAt }>` (`embedder.ts:177`)
   is NOT weak**. `cleanupStaleInflight()` only fires every 30s and only
   removes entries older than 60s. Between cleanups, every inflight embed
   adds an entry. Under load (e.g., startup burst where 100 embeds are
   pending), this map holds 100 entries. Each entry holds a reference to its
   `AbortSignal` via closure — **and that signal is also a key in
   `_signalIds`** (because `inflightKey` used it). So the chain keeps the
   signal alive past its natural lifetime.

   This is not a memory leak per se (cleanup eventually fires), but during a
   60s burst window the embedder pins 60s of AbortSignals.

**Impact**: Slow memory growth in long-running embedding bursts; WeakMap
correctness in the `signal` key path is OK but depends on the entire signal
closure being unreferenced.

**Proposed fix**: Use `inflightKey` based on the signal itself (via a
`WeakRef<AbortSignal>` → counter map), not a `WeakMap` that needs the signal
alive. Alternative: use `Map<WeakRef<AbortSignal>, number>` and periodically
prune. Or simply store the signalId in the inflight map value alongside the
promise.

---

### P1-1 — `Embedder` cache key uses `text` without length cap
**File**: `src/embedder.ts:761-762`
**Post-CR regression (new issue)**

```ts
async embedWithInflight(text: string, task: string | undefined, label: string, signal?: AbortSignal): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot embed empty text");
  }

  const cached = this._cache.get(text, task);
  if (cached) return cached;
```

The cache key is derived from the full text (`embedding-cache.ts:46-51`). For a
memory text up to `MAX_EMBED_DEPTH=3` recursion × `STRICT_REDUCTION_FACTOR=0.5`,
the worst-case cache key is the original text length. The `EmbeddingCache` is
LRU with `maxSize = 1024` (default, but `Embedder` constructs it with `1024`
at `embedder.ts:241-243` — wait, actually it uses `cacheConfig.maxSize ?? 1024`,
so default 1024). Each entry stores a full vector (`number[]`) of `dimensions`
floats. For `text-embedding-3-small` at 1536 dimensions, that's 1536 × 8 = 12 KB
per vector. 1024 entries × 12 KB = ~12 MB per Embedder. **Acceptable.**

But for **batch** embedding, `embedMany` (`embedder.ts:928-1082`) stores each
result via `this._cache.set(uncachedTexts[idx], task, embedding)` — same size
per entry. **Worst case**: a 1000-text batch can fill 1000 cache slots in one
shot, evicting the LRU. This is fine.

**Actual concern**: `_cache.get` does not have a TTL check inside
`embedWithInflight` — but it does (`embedding-cache.ts:60-64` checks
`Date.now() - entry.createdAt > this.ttlMs`). ✓

**Wait — the cache key is `text` directly. When `embedSingle` recursively
truncates the text and calls `embedSingle(truncated, task, depth+1, signal)`,
the *truncated* text is cached, but the next call sees the **original** text
(only the **original** is the caller-visible key):

Actually, the original `embedSingle(text, ...)` checks cache for `text` first
(line 818), then on retry calls `embedSingle(truncated, ...)` which caches
`truncated`. The original caller's key never gets cached (because the embed
succeeded for `truncated`, not `text`). **The truncated text's embedding is
returned to the original caller, but it is NOT cached under `text`'s key.**
Future calls with `text` re-embed from scratch.

This is **not a regression** but a pre-existing bug surfaced during review.
The fix would be to also cache under `text` (with the truncated vector as
value) at the entry of `embedSingle`.

**Impact**: Repeated embedding of long documents (which get truncated) re-embeds
every time, losing the embedding cache benefit. Cost: per-call latency + cost.
For example, a 6000-char document gets truncated to 3000, embedded, cached under
3000-char key. Next call: full 6000-char, cache miss for `text=6000`,
re-truncate to 3000, **cache hit for 3000-char** — OK actually. The original
text path does benefit via the truncation cache. ✓

False alarm — this works correctly because `embedSingle(truncated, ...)`
caches the truncated text under its own key, and the original text's
`embedSingle(text, ...)` only caches if the embed succeeded for `text` itself.

**No actual issue. Downgrading.**

---

### P1-2 — `flushJsonlWrites` and `MemoryStore.flushWrites` both correctly tail-chase, but `AccessTracker.flush()` does not tail-chase for in-flight retry
**File**: `src/access-tracker.ts:278-304`
**Post-CR regression**

```ts
async flush(): Promise<void> {
  this.clearTimer();
  if (this.flushPromise) {
    await this.flushPromise;
    if (this.pending.size > 0) {
      return this.flush();   // <-- recursive call: tail-chases once
    }
    return;
  }
  if (this.pending.size === 0) return;
  this.flushPromise = this.doFlush();
  try {
    await this.flushPromise;
  } finally {
    this.flushPromise = null;
  }
  if (this.pending.size > 0) {
    this.resetTimer();
  }
}
```

The recursive call only happens when the **same** `flush()` is awaited while a
flush is in flight. If `recordAccess()` is called *during* the in-flight
flush, the new delta is added to `this.pending` and detected after the flush
returns. The recursive `flush()` then runs **once**. If more data accumulates
during that recursive flush, it is detected at the end of the *outer* flush's
finally block and the **debounce timer** is reset (line 301). So during the
close() drain, this is fine: `close()` calls `flush()` repeatedly (via the
retry loop) until `pending.size === 0`.

But the retry loop only iterates `_maxRetries + 1 = 6` times. After 6 flushes
(including any recursive ones), close drops remaining pending writes. This is
documented in the CR fix log as intentional ("持续失败会记录明确 error 后再丢弃").
✓

**No P0/P1 finding here, but the dropped-count is not surfaced. See P0-2.**

---

### P1-3 — `FeedbackLoop.close()` does not await `runFeedbackDrainCycle` cleanup of in-flight store reads
**File**: `src/feedback-loop.ts:347-356`, `752-772`
**Post-CR regression**

```ts
private async runFeedbackDrainCycle(): Promise<void> {
  if (this.disposed) return;
  try {
    await this.drainPreventiveLessonBuffer();
  } catch { /* Non-critical: swallow */ }
}

private async runPriorAdaptationCycle(): Promise<void> {
  if (this.disposed || !this.config.priorAdaptation.enabled || !this.admissionController) return;
  const dbPath = this.runtimeContext.dbPath;
  const admissionConfig = this.runtimeContext.admissionConfig;
  if (!dbPath || !admissionConfig) return;
  try {
    await this.forceAdaptationCycle(dbPath, admissionConfig);
  } catch { /* Non-critical: swallow */ }
}
```

Both cycles catch all errors. `forceAdaptationCycle` reads the rejection audit
JSONL file (`feedback-loop.ts:716: readRecentRejectionAudits`) and writes the
new adaptive priors back to the `AdmissionController`. **This is purely
in-memory**, no store writes — good.

But `drainPreventiveLessonBuffer()` calls `learnPreventiveLesson` which calls
`this.lessonStore.list(...)`, `this.lessonStore.update(...)`, and
`this.lessonStore.store(...)` (`feedback-loop.ts:537, 563, 594`). These are
**store writes during shutdown drain**.

**Impact**: If the store was already closed (via the chain `closeStores()` →
`flushWrites()` → `table?.close()`) before `feedbackLoop.close()` finishes,
the writes will throw `Cannot read properties of null (reading 'add')` or
similar. The throw is caught by the `try/catch` inside `runFeedbackDrainCycle`,
which logs at debug level only. **The preventive lesson write is silently
lost.**

But: in `index.ts:733-748`, `feedbackLoop.close()` runs **before**
`closeStores()`. So the store is still alive when close runs. ✓

**Actual subtle issue**: The order `autoBackup.stop()` → `feedbackLoop.close()`
→ `closeStores()` is correct *only* because `closeStores` flushes the write
queue. **But what about reads?** After `MemoryStore.close()` sets `this.table =
null`, any pending `store.list()` call (e.g., from a slow
`runBackupOnce`) will hit `this.table!.query()` and crash. The lifecycle
drains `activeBackups` first, so backup reads are done before close. ✓

**However**: there is a window between `closeStores.flushWrites()` (which awaits
`_serialChain`) and `closeStores.close()` (which calls `table.close()`). During
this window, if a new `store.update()` is dispatched (via `recordAccess` or
auto-recall metadata accumulator's debounce timer), `_serialChain` is the same
chain because the same store instance is used — wait, but the
`AutoRecallMetadataAccumulator` was drained in `flushAutoRecallMetadata()`
before this point. ✓

**No actual P1 issue. Downgrading.**

---

### P1-4 — `dashboardServer.close()` not in stop path could leave listener open if close fails
**File**: `index.ts:495-504`, `744`
**Post-CR regression (new issue)**

```ts
const stopDashboard = async () => {
  const server = dashboardServer;
  dashboardServer = null;
  if (!server) return;
  try {
    await server.close();
  } catch (error) {
    api.logger.warn(`mymem：控制台停止失败：${String(error)}`);
  }
};
```

If `server.close()` rejects (e.g., already-closed socket), the local `server`
reference is gone (we set `dashboardServer = null`), so no retry is possible.
The HTTP server's listening socket may stay open if the close callback never
fires.

But `closeServer` (`src/dashboard-server.ts:1215-1219`) wraps `server.close()` in
a Promise. Node's `server.close()` always fires its callback when all
connections close, even on error. If there's an error, it rejects. So either
the promise resolves or rejects — no silent hang.

**However**: if `server.close()` is called while a keep-alive connection is
still in use, Node will wait until the connection drops before invoking the
callback. **This can block indefinitely** if the client (a browser tab) keeps
the connection open via SSE or similar. The dashboard does not use SSE, but
the auth cookie + fetch keep-alive may delay close by up to `keepAliveTimeout`
(30s in `embedder.ts:40`). **Long shutdown delay risk.**

**Impact**: In the worst case, plugin `stop()` hangs on
`await stopDashboard()` for up to ~30s waiting for the dashboard HTTP socket
to close.

**Proposed fix**:
- Force-close: `server.closeAllConnections?.()` (Node 18.2+) before awaiting
  `server.close()`.
- Or set a timeout: `Promise.race([server.close(), timeout(2s).then(() => server.closeAllConnections())])`.

---

### P1-5 — `concurrency-limiter.ts` `pending.onAbort` cleanup on abort may double-settle
**File**: `src/concurrency-limiter.ts:34-71`
**Post-CR regression (claimed fixed in commit log)**

```ts
async acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  if (this.inUse < this.limit) {
    this.inUse += 1;
    return this.makeRelease();
  }

  return new Promise<() => void>((resolve, reject) => {
    const pending: PendingPermit = { resolve, reject, signal };
    const cleanup = () => {
      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
    };
    const finish = (fn: () => void) => {
      if (pending.settled) return;
      pending.settled = true;
      cleanup();
      fn();
    };
    if (signal) {
      pending.onAbort = () => {
        const idx = this.queue.indexOf(pending);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
        }
        finish(() => reject(signal.reason ?? new Error("aborted")));
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    pending.resolve = (release) => finish(() => resolve(release));
    pending.reject = (reason) => finish(() => reject(reason));
    this.queue.push(pending);
  });
}
```

If the signal aborts, `pending.onAbort` removes from queue and rejects. The
`finish` wrapper sets `pending.settled = true` and calls `cleanup()` which
removes the listener. ✓

If `releaseNext()` shifts the pending out and calls `pending.resolve(...)`,
`finish` marks settled and cleans up. ✓

If the signal **aborts after** the pending has been granted (resolve fired),
`pending.settled = true`, so `finish` is a no-op. The listener is still
attached via the signal but the underlying promise has resolved; the abort
listener still fires when the signal aborts, calls `finish(() => reject(...))`
which is a no-op due to `pending.settled`. **The listener is never removed**
in this path. It's a `once: true` listener so it will fire once and remove
itself, but that's after the signal aborts — the listener may leak until then.

This is the **abort-after-grant** path. If the granted task uses the release
function and the signal aborts later, the listener fires once. Not a leak per
se because of `{ once: true }`. ✓

**However**: if the granted task **never** triggers the signal abort (normal
completion), the listener is cleaned up by `cleanup()` in `finish`. ✓

**Subtle issue**: When `releaseNext()` calls `pending.resolve(...)`, `finish`
calls `cleanup()` which removes the listener **only if** `signal` is truthy. But
`finish` is defined inside the Promise executor; `signal` is the closure
captured. ✓

**No actual issue.** The fix log says "queued acquires now ... queued grant and
skip canceled items all use one-shot cleanup" — matches.

---

### P1-6 — `Embedder.embedSingle` recursion with no abort listener cleanup on each recursion level
**File**: `src/embedder.ts:797-870`
**Pre-existing, surfaced by abort review**

`embedSingle` recursively calls itself on chunk failure (line 869:
`return this.embedSingle(truncated, task, depth + 1, signal);`). Each
recursion passes the same `signal`. If the signal aborts at recursion depth
2, the outer call has already returned (it was awaiting depth 1's return).
The listener attached at depth 0 was cleaned up by `withTimeout`'s `cleanup()`.
The listener at depth 1 is cleaned up the same way. ✓

But: `embedSingle` is invoked via `embedWithInflight` which wraps it in
`withTimeout(...)`. `withTimeout` (`embedder.ts:601-653`) attaches a listener
to the **external** signal:

```ts
if (externalSignal) {
  const handler = () => {
    const error = externalSignal.reason ?? new Error("aborted");
    controller.abort(error);
    finish(() => reject(error));
  };
  externalSignal.addEventListener("abort", handler, { once: true });
  unsubscribe = () => externalSignal.removeEventListener("abort", handler);
}
```

`finish` is called when the inner promise settles, and it calls `cleanup()`
which calls `unsubscribe()`. ✓

If `externalSignal` aborts AND `withTimeout` fires, both try to reject.
`finish` is idempotent (`if (settled) return`). ✓

**No actual issue. The P1-6 fix is correct.**

---

### P1-7 — `LLM client` retry uses a single timeout signal across all attempts — first attempt's fetch abort may cancel retry
**File**: `src/llm-client.ts:466-517`
**Pre-existing**

`createOauthClient` creates a SINGLE `createTimeoutSignal(config.timeoutMs)`
in `completeJson` (line 471) which covers the entire `withLlmRetries`
operation. So if `config.timeoutMs = 30s` and the LLM takes 20s on attempt 1,
fails, then retry delay is `100 * 2^0 = 100ms`, then attempt 2 fetch begins.
The signal still has 30s - 20s - 100ms = ~9.9s left. The retry can use it.

**However**: when `controller.abort()` fires (after 30s), it stays aborted. If
the retry loop continues, the next `fetch(endpoint, { signal })` is given an
**already-aborted** signal. The fetch throws immediately. `withLlmRetries`
catches and checks `isRetryableLlmError(error)` — for an abort error, neither
status match nor message match applies (no 408/429/500/502/503/504 in the
abort message). So `isRetryableLlmError` returns `false` → throw. ✓

But there's a subtle case: the retry delay itself is `await delay(delayMs,
params.signal)`. If the signal aborts during the delay, `delay` rejects with
`signal.reason`, which propagates up and **bypasses** `withLlmRetries`'s
catch — it goes up to the outer `try/catch` in `completeJson`, which catches
and logs. ✓

**Issue**: when the signal aborts between attempts and we retry, the abort
error from the next fetch goes back into the retry loop, fails
`isRetryableLlmError` check, and is thrown. That's the same error path
regardless. ✓

**Subtle but real issue**: `withLlmRetries` does not differentiate
retryable errors from "we ran out of time". If the outer signal aborts
mid-retry, the throw propagates up to `completeJson`'s catch and logs
"OAuth request failed". The caller (e.g. `SmartExtractor`) sees this as a
generic failure and may treat it as a transient error, potentially scheduling
a retry that re-enters `completeJson` with a fresh `signal` (from the
extractor's own controller). Two layers of retry.

This is **not a bug per se** — defensive retry is OK. But the **delay** between
attempts inside `withLlmRetries` does not propagate the `signal.reason`
correctly when the timeout fires **during** the delay. Looking at
`delay()` (`llm-client.ts:213-230`):

```ts
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
```

If `signal` aborts during the delay, `onAbort` clears the timer and rejects.
✓ The `signal.removeEventListener` happens inside the timer callback
(only fires if the timer ran to completion). If abort fires first, the
listener is `{ once: true }` so it self-removes. ✓

**No actual issue.**

---

### P1-8 — `reranker.ts` `raceWithAbort` returns `work` result even if `externalAbortPromise` won — leaks settled promise
**File**: `src/reranker.ts:295-298`
**Pre-existing**

```ts
const raceWithAbort = async <T>(work: Promise<T>): Promise<T> => await Promise.race(
  externalAbortPromise
    ? [work, timeoutPromise, externalAbortPromise]
    : [work, timeoutPromise],
);
```

When timeout fires, `timeoutCtrl.abort("rerank-timeout")` is called. The
`fetch(endpoint, { signal: combinedSignal })` will be aborted (combinedSignal
includes `timeoutCtrl.signal`). The fetch promise rejects with an AbortError.
`Promise.race` returns the first rejection — which is `timeoutPromise`'s
rejection (`new DOMException("Rerank timed out", "AbortError")`). The fetch's
own rejection is swallowed.

If `externalAbortPromise` won instead, the fetch is also aborted
(`externalCtrl.abort("rerank-external")`), and again the fetch's rejection is
swallowed by `Promise.race`.

The fetch promise's rejection becomes an unhandled rejection. ✓ (Actually,
`Promise.race` accepts the first to settle; the others still resolve/reject.
If a rejection happens but the race has already settled to a different value,
the losing rejection becomes an unhandled rejection.)

This is a real **Node unhandled rejection** path if `fetch` rejects with
`AbortError` and `raceWithAbort` returns the abort promise's rejection — the
fetch rejection is unhandled.

**Impact**: Under Node's default `--unhandled-rejections=throw` mode, this
**crashes the process** if `fetch` rejects with anything other than AbortError.
With `--unhandled-rejections=warn` (default in Node 15+), it's logged but
survives.

**Proposed fix**: `await Promise.race(...)` then `await work.catch(() => {})`
to absorb any later rejection.

---

### P2-1 — `_signalIds` in `Embedder` monotonic counter can grow without bound in test scenarios
**File**: `src/embedder.ts:177-179`
**New issue**

```ts
private _nextSignalId = 1;
```

This is a simple counter. If the embedder is long-lived and processes millions
of signals, `_nextSignalId` reaches `Number.MAX_SAFE_INTEGER` (~9 quadrillion)
— never a practical concern. ✓

But the `_signalIds` WeakMap keys are `AbortSignal`s. JS WeakMap holds weak
refs; once the signal is GC'd, the entry is collected. So memory is bounded by
the number of **alive** signals, which is bounded by the number of in-flight
embeds. ✓

**No issue.** Downgrading to informational.

---

### P2-2 — `dashboardServer.close()` may not stop accepting new requests until existing ones complete
**File**: `src/dashboard-server.ts:1215-1219`, `index.ts:495-504`
**Pre-existing**

Node's `server.close()` stops accepting new connections but waits for existing
ones to close. With `keepAliveTimeout = 30s`, the dashboard may keep the
process alive for up to 30s after stop. **Already noted in P1-4.**

---

### P2-3 — `AutoRecallMetadataAccumulator.flushNow()` clears `this.timer` then runs `flushPending` — but a debounce-fired flush is independent
**File**: `src/auto-recall-metadata-accumulator.ts:109-128`
**Pre-existing**

```ts
async flushNow(): Promise<void> {
  const inFlight = this.activeFlush;
  if (inFlight) {
    await inFlight;
  }

  if (this.timer) {
    clearTimeout(this.timer);
    this.timer = null;
  }

  if (this.pending.size === 0) return;

  this.activeFlush = this.flushPending();
  try {
    await this.activeFlush;
  } finally {
    this.activeFlush = null;
  }
}
```

If the debounce timer fires concurrently with `flushNow()` being called:
1. Timer fires, schedules `void this.flushNow().catch(...)` (line 170).
2. `flushNow()` runs, awaits `inFlight` (null, since this is the first).
3. Timer's `flushNow()` (let's call it T) sets `this.activeFlush = flushPending()`.
4. **Race**: original `flushNow()` (let's call it O) also wants to set
   `this.activeFlush`. T's call sees `inFlight = null`, O's call also sees
   `inFlight = null` (both check before either sets it).

But JS is single-threaded: T's microtask and O's microtask cannot interleave
at the statement level. One runs to completion before the other starts. The
first to set `this.activeFlush` wins. The second sees `inFlight` is not null
and awaits. ✓

`flushPending` (`auto-recall-metadata-accumulator.ts:130-164`) reads
`this.pending` into a local Map then clears `this.pending`. If T's call
cleared `this.pending` before O's call starts, O sees `pending.size === 0`
and returns early. ✓ If O runs first, T awaits the in-flight, then sees
`pending.size === 0` (cleared by O), returns. ✓

**No actual race. ✓**

---

### P2-4 — `MemoryStore.stats` cache is invalidated by writes — but reads also reset on write? No — reads do not reset.
**File**: `src/store.ts:1628-1636`
**Pre-existing**

```ts
if (
  this._statsCache &&
  this._statsCache.key === cacheKey &&
  Date.now() - this._statsCache.ts < MemoryStore.STATS_CACHE_TTL_MS
) {
  return this._statsCache.result;
}
```

The stats cache has a 30s TTL. Writes invalidate it (`this._statsCache = null`
at lines 276, 1185, 1224, 1543, 1755, 1798, 1848, 1907, 1946). Reads do not
extend the TTL. ✓

If a write happens at second 0 (cache cleared), then no further writes for 30s,
a `stats()` call at second 29 returns the cached result from second 0 — which
**does not reflect** the second-0 write (because the cache was cleared, but
then a subsequent stats() call at second 1 re-cached it).

Actually, the write cleared the cache, then the next stats() call after the
write re-populates it. So the cached result IS post-write. ✓

**No issue.**

---

### P2-5 — `plugin-singleton.ts` exposes `_singletonState` as module-level mutable — hot-reload could leave two singletons
**File**: `src/plugin-singleton.ts:88-96`
**Pre-existing architectural concern**

```ts
let _singletonState: PluginSingletonState | null = null;
export function getSingletonState(): PluginSingletonState | null {
  return _singletonState;
}
export function setSingletonState(state: PluginSingletonState | null): void {
  _singletonState = state;
}
```

If OpenClaw hot-reloads the plugin and re-instantiates `index.ts`, the module
is re-imported. **But Node ESM modules are cached** — the `_singletonState`
variable persists across `register()` calls. The WeakSet `_registeredApis` at
`index.ts:65` deduplicates per-api-instance but the **module-level
`_singletonState` is shared across api instances**.

When the host hot-reloads, it may pass a new `api` object. The WeakSet adds
it. `_pluginStateFactory(api)` runs, creating a NEW state. `_singletonState`
is overwritten. The OLD state (with all the background tasks) is orphaned.

The OLD state's `MemoryStore` is still alive in memory (referenced by
`store` field of the old state object). Its `_pendingRecordHooks` (telemetry),
its `_inflightSingle` map, its `_statsCache` — all retained.

When the OLD `service.stop()` was called on the previous api, it awaited
drains. But the lifecycle only awaits if `api.registerService` was called.
On hot-reload, the previous stop may not have completed.

**Impact**: Two `MemoryStore` instances pointing at the same LanceDB
directory. Both have `_serialChain` queues. Both call `runWithFileLock` which
acquires the **same** file lock. So writes are serialized at the OS level.
✓ But `flushWrites()` on store A doesn't wait for store B's queue. ✓

Read contention: `stats()` cache from store A may be stale w.r.t. writes
through store B. The LanceDB connection is shared (same file) — both
connections hold open file handles. LanceDB may not handle concurrent
connections well.

**Impact**: Subtle read-after-write inconsistency between two live store
instances during hot-reload. No data loss, but the dashboard/CLI stats may be
stale for up to 30s.

**Proposed fix**: Tear down the previous singleton before instantiating a new
one. Add a `teardownSingleton()` that awaits all drains + closes all stores.

---

### P3-1 — `dashboardServer.close()` is called after `flushTelemetry` — telemetry flush may take a while if a slow JSONL append is in flight
**File**: `index.ts:743-744`
**Cosmetic**

Telemetry flush drains telemetry hooks first, then JSONL. Dashboard close
only blocks on HTTP socket close. Both are quick (<2s typically). ✓

---

### P3-2 — `AccessTracker.destroy()` is dead code
**File**: `src/access-tracker.ts:330-353`
**Code hygiene**

`destroy()` exists but is never called. The lifecycle uses `close()` via
`retriever.flushAccessTrackers()`. Either remove `destroy()` or document why
both exist.

---

## What's working well

1. **`MemoryStore.flushWrites()`, `AuditLogger.flush()`, and
   `TelemetryStore.flushJsonlWrites()` all correctly tail-chase**. They
   re-read the chain end on each iteration. Verified at `src/store.ts:333-339`,
   `src/audit-log.ts:73-79`, and `src/telemetry.ts:83-92`. The CR fix log's
   "store write queue tail-chasing drain" and "audit log flush tail-chasing
   drain" entries are actually implemented.

2. **`ConcurrencyLimiter` abort listener cleanup is correct**. The fix log
   entry "concurrency limiter abort cleanup" is properly implemented at
   `src/concurrency-limiter.ts:34-71` — listener removed on grant, abort, and
   skip. ✓

3. **`AutoBackup.stop()` cancels timers first, then drains active backups**.
   Correct order — the active backup's `store.list()` reads complete before
   `closeStores()` runs.

4. **`Embedder.retryWithBackoff()` correctly honors external abort**.
   `delayUnlessAborted` at `embedder.ts:577-593` removes the timer listener
   on both abort and resolve. ✓

5. **`OAuth LLM body timeout** is wired through `response.text()` and
   `response.json()` via `readTextUnlessAborted` / `readJsonUnlessAborted`
   (`src/llm-oauth.ts:363-407`). ✓

6. **`AutoRecallMetadataAccumulator.flushNow()` correctly waits for in-flight
   scheduled flush**. `await this.activeFlush` at line 112 ensures no overlap.
   ✓

7. **`FeedbackLoop.close()` clears timers and drains both `activeTasks` and
   `rejectionAuditWrites`** before attempting the in-memory rejection buffer
   flush. ✓

8. **`Embedder.withTimeout()` correctly rejects immediately on external abort
   rather than waiting for the provider promise**. ✓

9. **Lockfile staleness handling is layered**: `runWithFileLockUnlocked` at
   `src/store.ts:784-835` proactively unlinks stale locks (>5min old) before
   calling `lockfile.lock()` with `stale: 10000` as a safety net. ✓

10. **Lock file mkdir `EEXIST` is silently swallowed** — the lock directory
    is shared across concurrent callers. ✓

11. **All `flush*()` and `close*()` methods swallow errors and log them**.
    This is intentional per CR-7 ("mutation audit 不是可 flush 的审计日志")
    and similar. Errors don't propagate to block shutdown.

12. **`closeStores` calls `flushWrites` then `flushAuditLog` then `close`**
    in the right order. `flushWrites` drains the in-process write queue,
    `flushAuditLog` drains the audit queue (which records write events), then
    `close` releases handles.

---

## Recommendations (prioritized)

| Priority | Fix | Estimated effort |
|---|---|---|
| P0-1 | Add instance fencing to `MemoryStore` and telemetry file queues so hot-reload does not interleave | 2-3 days |
| P0-2 | Surface `AccessTracker` dropped-on-shutdown count via dashboard | 0.5 day |
| P0-3 | Switch `Embedder._signalIds` to `WeakRef<AbortSignal>` keyed map; document inflight pin lifetime | 1 day |
| P1-4 | Add `server.closeAllConnections()` and 2s timeout to dashboard stop | 0.25 day |
| P1-8 | Absorb losing fetch rejections in `reranker.ts:raceWithAbort` | 0.25 day |
| P2-5 | Implement `teardownSingleton()` and call it before re-init on hot-reload | 1 day |
| P3-2 | Remove dead `AccessTracker.destroy()` | 0.1 day |

---

## Appendix — Verification commands

- `npm run typecheck` — passes.
- `npm run lint` — passes.
- The slimmed smoke suite (`npm test`) does **not** exercise any of the
  shutdown-drain paths reviewed here. The `docs/code-review-2026-06-28.md`
  fix log lists 12 new tests that were removed in commit `b6dd1ca`. Re-adding
  a focused subset (especially `store-write-queue`, `access-tracker.close`,
  `feedback-loop.close`, `concurrency-limiter`) is strongly recommended.