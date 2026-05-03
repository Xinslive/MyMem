/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { Index as LanceDbIndex } from "@lancedb/lancedb";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSmartMetadata, isMemoryActiveAt, stringifySmartMetadata } from "./smart-metadata.js";
import { hasActiveRecallSuppression } from "./recall-suppression.js";
import type { MemoryCategory } from "./memory-categories.js";
import { clampInt } from "./utils.js";
import { createLogger, type Logger } from "./logger.js";

import type { MemoryEntry, MemorySearchResult, StoreConfig, MetadataPatch, StoreIndexStatus, LanceRow, LanceIndex } from "./store-types.js";
import {
  FULL_ENTRY_COLUMNS,
  LIST_ENTRY_COLUMNS,
  DEFAULT_SCALAR_INDEX_COLUMNS,
  MIN_VECTOR_INDEX_ROWS,
  escapeSqlLiteral,
  isExplicitDenyAllScopeFilter,
  buildScopeWhereClause,
  combineWhereClauses,
  prefixWhereClause,
  isVectorIndexType,
  isScalarIndexType,
  recommendedVectorPartitions,
  tokenSetForSearch,
  scoreLexicalHitPreTokenized,
  normalizeSearchText,
  resolveMemoryId,
} from "./store-sql-utils.js";
import { toLanceRows, mapRowToMemoryEntry } from "./store-row-mappers.js";
import { loadLanceDB } from "./lancedb-loader.js";

/** Async stat that returns null instead of throwing on ENOENT. */
async function statAsync(filePath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Re-export all public symbols for backward compatibility
export type { MemoryEntry, MemorySearchResult, StoreConfig, MetadataPatch, StoreIndexStatus } from "./store-types.js";
export {
  FULL_ENTRY_COLUMNS,
  LIST_ENTRY_COLUMNS,
  DEFAULT_SCALAR_INDEX_COLUMNS,
  MIN_VECTOR_INDEX_ROWS,
  escapeSqlLiteral,
  normalizeSearchText,
  isExplicitDenyAllScopeFilter,
  buildScopeWhereClause,
  combineWhereClauses,
  prefixWhereClause,
  isVectorIndexType,
  isScalarIndexType,
  recommendedVectorPartitions,
  scoreLexicalHit,
} from "./store-sql-utils.js";
export { toLanceRows, toNumberVector, mapRowToMemoryEntry } from "./store-row-mappers.js";
export { loadLanceDB } from "./lancedb-loader.js";
export { validateStoragePath } from "./storage-path.js";

// ============================================================================
// Cross-Process File Lock (proper-lockfile)
// ============================================================================

interface LockfileModule {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
}

let lockfileModule: LockfileModule | null = null;

async function loadLockfile(): Promise<LockfileModule> {
  if (!lockfileModule) {
    lockfileModule = (await import("proper-lockfile")) as unknown as LockfileModule;
  }
  return lockfileModule;
}

// ============================================================================
// Memory Store
// ============================================================================

/** Return type of MemoryStore.stats() — used for cache typing. */
type StatsResult = {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  memoryCategoryCounts: Record<string, number>;
  recentActivity: { last24h: number; last7d: number; last30d: number };
  tierDistribution: Record<string, number>;
  healthSignals: { badRecall: number; suppressed: number; lowConfidence: number };
};

const TABLE_NAME = "memories";
const serializedStoreContext = new AsyncLocalStorage<Set<object>>();
const batchStoreContext = new AsyncLocalStorage<Map<object, MemoryEntry[]>>();
const METADATA_BATCH_CHUNK_SIZE = 200;
const FTS_INDEX_VERSION = "ngram-v1";
const FTS_INDEX_VERSION_FILE = ".mymem-fts-index.version";

type BatchRunOptions = {
  onBeforeFlush?: () => void;
};

export class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsIndexCreated = false;
  private vectorIndexCreated = false;
  private scalarIndexedColumns = new Set<string>();

  // Flush-batch: buffer store() calls and write them in a single lock acquisition.
  private _batchBuffer: MemoryEntry[] = [];
  private _batchActive = false;

  // In-process write serialization. Tail is reset when the queue drains so a
  // long-running process does not retain an ever-growing promise chain.
  private _serialChain: Promise<void> = Promise.resolve();

  // Stats result cache (invalidated on writes)
  private _statsCache: { key: string; result: StatsResult; ts: number } | null = null;
  private static STATS_CACHE_TTL_MS = 30_000;

  // Lock staleness check cooldown — skip stat() if lock was verified fresh recently.
  private _lastFreshLockCheckAt = 0;
  private static readonly LOCK_CHECK_COOLDOWN_MS = 30_000;

  /** Logger instance for structured logging. */
  private log: Logger;

  /** Enter batch mode — subsequent store() calls buffer instead of writing immediately. */
  startBatch(): void {
    this._batchActive = true;
  }

  /** Exit batch mode and discard buffered entries. Used when a batch owner aborts before flushing. */
  cancelBatch(): MemoryEntry[] {
    const contextBuffer = batchStoreContext.getStore()?.get(this);
    if (contextBuffer) {
      const discarded = contextBuffer.splice(0, contextBuffer.length);
      batchStoreContext.getStore()?.delete(this);
      return discarded;
    }

    this._batchActive = false;
    const discarded = this._batchBuffer;
    this._batchBuffer = [];
    return discarded;
  }

  /**
   * Run a function with async-context-local batch buffering for this store.
   * This avoids exposing unrelated concurrent store() calls to a process-wide
   * batch flag while still flushing the owned writes in one lock acquisition.
   */
  async runBatch<T>(
    fn: () => Promise<T> | T,
    options: BatchRunOptions = {},
  ): Promise<{ result: T; written: MemoryEntry[] }> {
    const activeBatches = batchStoreContext.getStore();
    if (activeBatches?.has(this)) {
      return { result: await fn(), written: [] };
    }

    const batchBuffer: MemoryEntry[] = [];
    const nextBatches = new Map(activeBatches ?? []);
    nextBatches.set(this, batchBuffer);

    return batchStoreContext.run(nextBatches, async () => {
      try {
        const result = await fn();
        options.onBeforeFlush?.();
        const written = await this.flushBatch();
        return { result, written };
      } catch (err) {
        batchBuffer.length = 0;
        throw err;
      } finally {
        nextBatches.delete(this);
      }
    });
  }

  /**
   * Flush all buffered entries in a single lock acquisition.
   * Returns the written entries. Exits batch mode afterwards.
   * If no entries buffered, exits batch mode and returns empty array (no lock acquired).
   */
  async flushBatch(): Promise<MemoryEntry[]> {
    const contextBuffer = batchStoreContext.getStore()?.get(this);
    if (contextBuffer) {
      const entries = contextBuffer.splice(0, contextBuffer.length);
      try {
        return await this.writeBatchEntries(entries);
      } catch (err) {
        contextBuffer.unshift(...entries);
        throw err;
      }
    }

    this._batchActive = false;
    const entries = this._batchBuffer.splice(0, this._batchBuffer.length);
    try {
      return await this.writeBatchEntries(entries);
    } catch (err) {
      this._batchBuffer.unshift(...entries);
      throw err;
    }
  }

  private async writeBatchEntries(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (entries.length === 0) return [];

    await this.ensureInitialized();
    const written = await this.runWithFileLock(async () => {
      try {
        await this.table!.add(toLanceRows(entries));
      } catch (err: unknown) {
        const code = (err as Record<string, unknown>)?.code || "";
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to flush-batch store ${entries.length} memories: ${code} ${message}`,
        );
      }
      return entries;
    });
    this._statsCache = null;
    await this.maybeCreateDeferredVectorIndex();
    return written;
  }

  constructor(private readonly config: StoreConfig) {
    this.log = config.logger ?? createLogger();
  }

  async runSerializedUpdate<T>(fn: () => Promise<T> | T): Promise<T> {
    const activeStores = serializedStoreContext.getStore();
    if (activeStores?.has(this)) {
      return fn();
    }

    const runInContext = () => {
      const nextStores = new Set(serializedStoreContext.getStore() ?? []);
      nextStores.add(this);
      return serializedStoreContext.run(nextStores, fn);
    };

    const run = this._serialChain.then(runInContext, runInContext);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this._serialChain = next;

    try {
      return await run;
    } finally {
      if (this._serialChain === next) {
        this._serialChain = Promise.resolve();
      }
    }
  }

  private async countRowsWithFilter(whereClause?: string): Promise<number> {
    if (!this.table) return 0;
    return whereClause ? this.table.countRows(whereClause) : this.table.countRows();
  }

  private async getIndexStatusInternal(table: LanceDB.Table): Promise<StoreIndexStatus> {
    const [indices, totalRows] = await Promise.all([
      table.listIndices(),
      table.countRows(),
    ]);
    const scalar = new Set<string>();
    let hasFts = false;
    let hasVector = false;

    for (const index of indices) {
      const columns = Array.isArray(index.columns) ? index.columns : [];
      if (index.indexType === "FTS" || columns.includes("text")) {
        hasFts = true;
      }
      if (columns.includes("vector") || isVectorIndexType(index.indexType)) {
        hasVector = true;
      }
      if (isScalarIndexType(index.indexType)) {
        for (const column of columns) {
          if (column !== "vector" && column !== "text") scalar.add(column);
        }
      }
    }

    this.ftsIndexCreated = hasFts;
    this.vectorIndexCreated = hasVector;
    this.scalarIndexedColumns = scalar;
    if (hasFts) {
      this._lastFtsError = null;
    }

    return {
      totalRows,
      totalIndices: indices.length,
      names: indices.map((index) => index.name),
      available: {
        fts: hasFts,
        vector: hasVector,
        scalar: Array.from(scalar).sort((left, right) => left.localeCompare(right)),
      },
      exhaustiveVectorSearch: !hasVector,
      missingRecommendedScalars: DEFAULT_SCALAR_INDEX_COLUMNS.filter((column) => !scalar.has(column)),
      vectorIndexPending: !hasVector && totalRows >= MIN_VECTOR_INDEX_ROWS,
    };
  }

  private async ensureScalarIndex(
    table: LanceDB.Table,
    column: string,
    kind: "btree" | "bitmap",
    cachedStatus?: StoreIndexStatus,
  ): Promise<void> {
    const current = cachedStatus ?? await this.getIndexStatusInternal(table);
    if (current.available.scalar.includes(column)) return;

    const config = kind === "bitmap"
      ? LanceDbIndex.bitmap()
      : LanceDbIndex.btree();
    await table.createIndex(column, {
      config,
      replace: false,
      waitTimeoutSeconds: 30,
      train: true,
    });
  }

  private async ensureVectorIndex(table: LanceDB.Table, totalRows: number, cachedStatus?: StoreIndexStatus): Promise<void> {
    const current = cachedStatus ?? await this.getIndexStatusInternal(table);
    if (current.available.vector || totalRows < MIN_VECTOR_INDEX_ROWS) return;

    await table.createIndex("vector", {
      config: LanceDbIndex.ivfFlat({
        distanceType: "cosine",
        numPartitions: recommendedVectorPartitions(totalRows),
      }),
      replace: false,
      waitTimeoutSeconds: 120,
    });
  }

  private async ensureRecommendedIndices(table: LanceDB.Table): Promise<void> {
    const status = await this.getIndexStatusInternal(table);

    const scalarPlans: Array<{ column: string; kind: "btree" | "bitmap" }> = [
      { column: "id", kind: "btree" },
      { column: "scope", kind: "bitmap" },
      { column: "category", kind: "bitmap" },
      { column: "timestamp", kind: "btree" },
    ];

    for (const plan of scalarPlans) {
      if (status.available.scalar.includes(plan.column)) continue;
      try {
        await this.ensureScalarIndex(table, plan.column, plan.kind, status);
      } catch (error) {
        this.log.warn(`mymem: failed to create scalar index on ${plan.column}: ${String(error)}`);
      }
    }

    try {
      await this.ensureVectorIndex(table, status.totalRows, status);
    } catch (error) {
      this.log.warn(`mymem: failed to create vector index: ${String(error)}`);
    }

    await this.getIndexStatusInternal(table);
  }

  private async maybeCreateDeferredVectorIndex(): Promise<void> {
    if (!this.table || this.vectorIndexCreated) return;
    try {
      const totalRows = await this.table.countRows();
      if (totalRows < MIN_VECTOR_INDEX_ROWS) return;
      await this.ensureVectorIndex(this.table, totalRows);
      await this.getIndexStatusInternal(this.table);
    } catch (error) {
      this.log.warn(`mymem: deferred vector index creation failed: ${String(error)}`);
    }
  }

  private buildBaseWhereClause(scopeFilter?: string[], category?: string, extraConditions: string[] = []): string | undefined {
    return combineWhereClauses([
      buildScopeWhereClause(scopeFilter),
      category ? `category = '${escapeSqlLiteral(category)}'` : undefined,
      ...extraConditions,
    ]);
  }

  private async findListWindowLowerBound(
    baseWhere: string | undefined,
    neededCount: number,
    upperExclusive: number,
  ): Promise<number | null> {
    let lower = Math.max(0, upperExclusive - 24 * 60 * 60 * 1000);
    let previousLower = upperExclusive;
    let count = await this.countRowsWithFilter(
      combineWhereClauses([
        baseWhere,
        `timestamp >= ${lower}`,
        `timestamp < ${upperExclusive}`,
      ]),
    );

    let attempts = 0;
    while (count < neededCount && lower > 0 && attempts < 12) {
      previousLower = lower;
      lower = Math.max(0, upperExclusive - (upperExclusive - lower) * 2);
      count = await this.countRowsWithFilter(
        combineWhereClauses([
          baseWhere,
          `timestamp >= ${lower}`,
          `timestamp < ${upperExclusive}`,
        ]),
      );
      attempts++;
    }

    if (count < neededCount) return null;

    let low = lower;
    let high = previousLower;
    for (let i = 0; i < 12 && high - low > 1000; i++) {
      const mid = low + Math.floor((high - low) / 2);
      const midCount = await this.countRowsWithFilter(
        combineWhereClauses([
          baseWhere,
          `timestamp >= ${mid}`,
          `timestamp < ${upperExclusive}`,
        ]),
      );
      if (midCount >= neededCount) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return low;
  }

  private async fetchListRows(whereClause?: string): Promise<MemoryEntry[]> {
    let query = this.table!.query().select(LIST_ENTRY_COLUMNS as unknown as string[]);
    if (whereClause) {
      query = query.where(whereClause);
    }
    const rows = await query.toArray();
    return rows.map((row) => mapRowToMemoryEntry(row, false));
  }

  private async fetchFullRowsByIds(ids: string[]): Promise<MemoryEntry[]> {
    const uniqueIds = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    if (uniqueIds.length === 0) return [];

    const entries: MemoryEntry[] = [];
    for (let i = 0; i < uniqueIds.length; i += METADATA_BATCH_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + METADATA_BATCH_CHUNK_SIZE);
      const idList = chunk.map((id) => `'${escapeSqlLiteral(id)}'`).join(",");
      const rows = await this.table!
        .query()
        .select(FULL_ENTRY_COLUMNS as unknown as string[])
        .where(`id IN (${idList})`)
        .limit(chunk.length)
        .toArray();
      for (const row of rows) {
        entries.push(mapRowToMemoryEntry(row));
      }
    }
    return entries;
  }

  private async mergeInsertEntriesInChunks(entries: MemoryEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i += METADATA_BATCH_CHUNK_SIZE) {
      const chunk = entries.slice(i, i + METADATA_BATCH_CHUNK_SIZE);
      if (chunk.length === 0) continue;
      await this.table!
        .mergeInsert(["id"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(toLanceRows(chunk));
    }
  }

  private async runWithFileLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.runSerializedUpdate(() => this.runWithFileLockUnlocked(fn));
  }

  private async runWithFileLockUnlocked<T>(fn: () => Promise<T>): Promise<T> {
    const lockfile = await loadLockfile();
    const lockPath = join(this.config.dbPath, ".memory-write.lock");

    // Ensure lock directory exists before locking
    try {
      await mkdir(dirname(lockPath), { recursive: true });
    } catch (err) {
      // EEXIST is fine; other errors are unexpected but non-fatal
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        this.log.warn(`failed to create lock directory: ${lockPath}: ${err}`);
      }
    }

    // Proactive cleanup of stale lock artifacts (fixes stale-lock ECOMPROMISED).
    // Skip stat() if lock was verified fresh within cooldown window.
    // lockfile.lock()'s own stale: 10000 option serves as a safety net.
    const now = Date.now();
    if (now - this._lastFreshLockCheckAt >= MemoryStore.LOCK_CHECK_COOLDOWN_MS) {
      try {
        const stat = await statAsync(lockPath);
        if (stat) {
          const ageMs = now - Number(stat.mtimeMs);
          const staleThresholdMs = 5 * 60 * 1000;
          if (ageMs > staleThresholdMs) {
            this._lastFreshLockCheckAt = 0; // Reset after stale cleanup
            try {
              await unlink(lockPath);
              this.log.warn(`cleared stale lock: ${lockPath} ageMs=${ageMs}`);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                this.log.warn(`failed to remove stale lock: ${lockPath}: ${err}`);
              }
            }
          } else {
            this._lastFreshLockCheckAt = now; // Lock was fresh
          }
        } else {
          this._lastFreshLockCheckAt = now; // No lock file = nothing stale
        }
      } catch {
        this._lastFreshLockCheckAt = now; // Can't read = proceed, mark checked
      }
    }

    const release = await lockfile.lock(lockPath, {
      realpath: false, // Fix #670: skip realpath() to avoid ENOENT after stale lock cleanup
      retries: { retries: 10, factor: 2, minTimeout: 200, maxTimeout: 5000 },
      stale: 10000,
    });
    try { return await fn(); } finally { await release(); }
  }

  get dbPath(): string {
    return this.config.dbPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();

    let db: LanceDB.Connection;
    try {
      db = await lancedb.connect(this.config.dbPath);
    } catch (err: unknown) {
      const code = (err as Record<string, unknown>)?.code || "";
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
        `  Fix: Verify the path exists and is writable. Check parent directory permissions.`,
      );
    }

    let table: LanceDB.Table;

    // Idempotent table init: try openTable first, create only if missing,
    // and handle the race where tableNames() misses an existing table but
    // createTable then sees it (LanceDB eventual consistency).
    try {
      table = await db.openTable(TABLE_NAME);

      // Migrate legacy tables: add missing columns for backward compatibility
      try {
        const schema = await table.schema();
        const fieldNames = new Set(schema.fields.map((f: { name: string }) => f.name));

        const missingColumns: Array<{ name: string; valueSql: string }> = [];
        if (!fieldNames.has("scope")) {
          missingColumns.push({ name: "scope", valueSql: "'global'" });
        }
        if (!fieldNames.has("timestamp")) {
          missingColumns.push({ name: "timestamp", valueSql: "CAST(0 AS DOUBLE)" });
        }
        if (!fieldNames.has("metadata")) {
          missingColumns.push({ name: "metadata", valueSql: "'{}'" });
        }

        if (missingColumns.length > 0) {
          this.log.warn(
            `migrating legacy table, adding columns: ${missingColumns.map((c) => c.name).join(", ")}`
          );
          await table.addColumns(missingColumns);
          this.log.info(
            `migration complete, ${missingColumns.length} column(s) added`
          );
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes("already exists")) {
          // Concurrent initialization race ??another process already added the columns
          this.log.info("mymem: migration columns already exist (concurrent init)");
        } else {
          this.log.warn(`could not check/migrate table schema: ${err}`);
        }
      }
    } catch {
      // Table doesn't exist yet ??create it
      const schemaEntry: MemoryEntry = {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.config.vectorDim }).fill(
          0,
        ) as number[],
        category: "other",
        scope: "global",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
      };

      try {
        table = await db.createTable(TABLE_NAME, toLanceRows([schemaEntry]));
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        // Race: another caller (or eventual consistency) created the table
        // between our failed openTable and this createTable ??just open it.
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Validate vector dimensions
    // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
    // Array.isArray() returns false for Arrow Vectors, so use .length instead.
    const sample = await table.query().limit(1).toArray();
    if (sample.length > 0 && sample[0]?.vector?.length) {
      const existingDim = sample[0].vector.length;
      if (existingDim !== this.config.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`,
        );
      }
    }

    // Create FTS index for BM25 search (graceful fallback if unavailable)
    this._lastFtsError = null;
    try {
      await this.createFtsIndex(table);
      this.ftsIndexCreated = true;
    } catch (err) {
      this._lastFtsError = err instanceof Error ? err.message : String(err);
      this.log.warn(
        "Failed to create FTS index, falling back to vector-only search:",
        err,
      );
      this.ftsIndexCreated = false;
    }

    await this.ensureRecommendedIndices(table);

    this.db = db;
    this.table = table;
  }

  private getFtsIndexVersionPath(): string {
    return join(this.config.dbPath, FTS_INDEX_VERSION_FILE);
  }

  private async readFtsIndexVersion(): Promise<string | null> {
    try {
      return (await readFile(this.getFtsIndexVersionPath(), "utf8")).trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.log.warn(`could not read FTS index version marker: ${err}`);
      return null;
    }
  }

  private async writeFtsIndexVersion(): Promise<void> {
    try {
      await writeFile(this.getFtsIndexVersionPath(), `${FTS_INDEX_VERSION}\n`, "utf8");
    } catch (err) {
      this.log.warn(`could not write FTS index version marker: ${err}`);
    }
  }

  private async createFtsIndex(
    table: LanceDB.Table,
    options: { force?: boolean } = {},
  ): Promise<void> {
    try {
      // Skip recreation if the FTS index was already created in this process
      // lifetime. The index uses ngram tokenizer and doesn't need migration
      // on subsequent doInitialize() calls.
      if (this.ftsIndexCreated && !options.force) {
        return;
      }

      // Check if FTS index already exists
      const indices = await table.listIndices();
      const existingFts = (indices as unknown as LanceIndex[])?.find(
        (idx) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );

      if (existingFts && !options.force) {
        const version = await this.readFtsIndexVersion();
        if (version === FTS_INDEX_VERSION) {
          return;
        }
      }

      const ftsConfig = LanceDbIndex.fts({
        withPosition: true,
        // ngram tokenizer: splits CJK text into 2-3 character tokens for BM25 matching.
        // Chinese "部署新版本" → ["部署","署新","新版本","版本"] enabling keyword search.
        // English "deploy" → ["de","ep","pl","lo","oy","dep","eplo","ploy"] — BM25 IDF
        // weighting ensures exact matches still score highest.
        baseTokenizer: "ngram",
        ngramMinLength: 2,
        ngramMaxLength: 3,
        lowercase: true,
      });

      if (existingFts) {
        // Migrate once: older stores may have been created with the simple
        // tokenizer. The version marker prevents repeating this on every start.
        try {
          await table.dropIndex((existingFts as LanceIndex).name || "text");
        } catch (err) {
          this.log.warn(`dropIndex for FTS migration failed: ${err}`);
        }
      }

      await table.createIndex("text", {
        config: ftsConfig,
        replace: true,
        waitTimeoutSeconds: 60,
      });
      await this.writeFtsIndexVersion();
    } catch (err) {
      throw new Error(
        `FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    };

    // Async-context batch mode: only the owning flow buffers its own writes.
    const contextBuffer = batchStoreContext.getStore()?.get(this);
    if (contextBuffer) {
      contextBuffer.push(fullEntry);
      return fullEntry;
    }

    // Legacy process-wide batch mode: retained for existing direct callers.
    if (this._batchActive) {
      this._batchBuffer.push(fullEntry);
      return fullEntry;
    }

    const stored = await this.runWithFileLock(async () => {
      try {
        await this.table!.add(toLanceRows([fullEntry]));
      } catch (err: unknown) {
        const code = (err as Record<string, unknown>)?.code || "";
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`,
        );
      }
      return fullEntry;
    });
    this._statsCache = null;
    await this.maybeCreateDeferredVectorIndex();
    return stored;
  }

  /**
   * Import a pre-built entry while preserving its id/timestamp.
   * Used for re-embedding / migration / A/B testing across embedding models.
   * Intentionally separate from `store()` to keep normal writes simple.
   */
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (!entry.id || typeof entry.id !== "string") {
      throw new Error("importEntry requires a stable id");
    }
    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`,
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope || "global",
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
      timestamp: Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : Date.now(),
      metadata: entry.metadata || "{}",
    };

    const imported = await this.runWithFileLock(async () => {
      await this.table!.add(toLanceRows([full]));
      return full;
    });
    this._statsCache = null;
    await this.maybeCreateDeferredVectorIndex();
    return imported;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const res = await this.table!.query()
      .select(["id"])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    return res.length > 0;
  }

  async hasIds(ids: string[]): Promise<Set<string>> {
    await this.ensureInitialized();
    const uniqueIds = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    if (uniqueIds.length === 0) return new Set();

    const idConditions = uniqueIds
      .map((id) => `id = '${escapeSqlLiteral(id)}'`)
      .join(" OR ");
    const rows = await this.table!.query()
      .select(["id"])
      .where(`(${idConditions})`)
      .limit(uniqueIds.length)
      .toArray();

    return new Set(rows.map((row) => row.id as string));
  }

  /** Lightweight total row count via LanceDB countRows(). */
  async count(): Promise<number> {
    await this.ensureInitialized();
    return await this.table!.countRows();
  }

  async getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return null;

    const safeId = escapeSqlLiteral(id);
    const rows = await this.table!
      .query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();

    if (rows.length === 0) return null;

    const entry = mapRowToMemoryEntry(rows[0]);
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(entry.scope)) {
      return null;
    }

    return entry;
  }

  private async findRowsByIdOrPrefix(
    id: string,
    columns: readonly string[],
  ): Promise<LanceRow[]> {
    const safeId = escapeSqlLiteral(id);
    const exactRows = await this.table!.query()
      .select(columns as unknown as string[])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray() as unknown as LanceRow[];
    if (exactRows.length > 0) return exactRows;

    let resolved: ReturnType<typeof resolveMemoryId>;
    try {
      resolved = resolveMemoryId(id);
    } catch {
      return [];
    }

    if (resolved.isFullId) return [];

    const prefixRows = await this.table!.query()
      .select(columns as unknown as string[])
      .where(prefixWhereClause("id", id))
      .limit(2)
      .toArray() as unknown as LanceRow[];
    if (prefixRows.length > 1) {
      throw new Error(
        `Ambiguous prefix "${id}" matches ${prefixRows.length} memories. Use a longer prefix or full ID.`,
      );
    }
    return prefixRows;
  }

  /**
   * Batch fetch multiple entries by ID in a single query.
   * Returns a Map for O(1) lookup. Missing IDs are silently omitted.
   */
  async getByIds(ids: string[]): Promise<Map<string, MemoryEntry>> {
    await this.ensureInitialized();
    if (ids.length === 0) return new Map();

    const safeIds = ids.map(id => `'${escapeSqlLiteral(id)}'`).join(",");
    const rows = await this.table!
      .query()
      .where(`id IN (${safeIds})`)
      .toArray();

    const result = new Map<string, MemoryEntry>();
    for (const row of rows) {
      const entry = mapRowToMemoryEntry(row);
      result.set(entry.id, entry);
    }
    return result;
  }

  async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[], options?: { excludeInactive?: boolean; overFetchMultiplier?: number }): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Ensure vector index exists before searching — without this, LanceDB
    // falls back to exhaustive scan which can take 5-10x longer.
    await this.maybeCreateDeferredVectorIndex();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const safeLimit = clampInt(limit, 1, 20);
    // Over-fetch more aggressively when filtering inactive records,
    // because superseded historical rows can crowd out active ones.
    const inactiveFilter = options?.excludeInactive ?? false;
    const overFetchMultiplier = clampInt(options?.overFetchMultiplier ?? (inactiveFilter ? 20 : 10), 1, 20);
    const fetchLimit = Math.min(safeLimit * overFetchMultiplier, 200);

    let query = this.table!.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);

    // Apply scope filter if provided
    const scopeWhere = buildScopeWhereClause(scopeFilter);
    if (scopeWhere) query = query.where(scopeWhere);

    const results = await query.toArray();
    const mapped: MemorySearchResult[] = [];

    for (const row of results) {
      const distance = Number(row._distance ?? 0);
      const score = 1 / (1 + distance);

      if (score < minScore) continue;

      const entry = mapRowToMemoryEntry(row);

      // Scope filter already applied in SQL WHERE — skip redundant app-layer check
      // Skip inactive (superseded) records when requested
      if (inactiveFilter && !isMemoryActiveAt(entry._parsedMeta!)) {
        continue;
      }

      mapped.push({ entry, score });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean; overFetchMultiplier?: number },
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const safeLimit = clampInt(limit, 1, 20);
    const inactiveFilter = options?.excludeInactive ?? false;
    // Over-fetch when filtering inactive records to avoid crowding
    const overFetchMultiplier = clampInt(options?.overFetchMultiplier ?? (inactiveFilter ? 20 : 1), 1, 20);
    const fetchLimit = inactiveFilter ? Math.min(safeLimit * overFetchMultiplier, 200) : safeLimit;

    if (!this.ftsIndexCreated) {
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    }

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(fetchLimit);

      // Apply scope filter if provided
      const scopeWhere = buildScopeWhereClause(scopeFilter);
      if (scopeWhere) searchQuery = searchQuery.where(scopeWhere);

      const results = await searchQuery.toArray();
      const mapped: MemorySearchResult[] = [];

      for (const row of results) {
        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        // LanceDB may return BigInt for numeric columns; coerce safely.
        const rawScore = row._score != null ? Number(row._score) : 0;
        const normalizedScore =
          rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;

        const entry = mapRowToMemoryEntry(row);

        // Scope filter already applied in SQL WHERE — skip redundant app-layer check
        // Skip inactive (superseded) records when requested
        if (inactiveFilter && !isMemoryActiveAt(entry._parsedMeta!)) {
          continue;
        }

        mapped.push({ entry, score: normalizedScore });

        if (mapped.length >= safeLimit) break;
      }

      if (mapped.length > 0) {
        return mapped;
      }
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    } catch (err) {
      this.log.warn("BM25 search failed, falling back to empty results:", err);
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    }
  }

  private async lexicalFallbackSearch(query: string, limit: number, scopeFilter?: string[], options?: { excludeInactive?: boolean; overFetchMultiplier?: number }): Promise<MemorySearchResult[]> {
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let searchQuery = this.table!.query().select([
      "id",
      "text",
      "category",
      "scope",
      "importance",
      "timestamp",
      "metadata",
    ]);

    const scopeWhere = buildScopeWhereClause(scopeFilter);
    if (scopeWhere) searchQuery = searchQuery.where(scopeWhere);

    const rows = await searchQuery.limit(limit + 500).toArray();
    const matches: MemorySearchResult[] = [];

    // Pre-tokenize query once (shared across all candidates)
    const normalizedQuery = normalizeSearchText(trimmedQuery);
    const queryTokens = tokenSetForSearch(normalizedQuery);

    for (const row of rows) {
      const entry = mapRowToMemoryEntry(row, false);
      const meta = entry._parsedMeta!;

      // Skip inactive (superseded) records when requested
      if (options?.excludeInactive && !isMemoryActiveAt(meta)) {
        continue;
      }

      const candidateFields = [
        { text: entry.text, weight: 1 },
        { text: meta.l0_abstract, weight: 0.98 },
        { text: meta.l1_overview, weight: 0.92 },
        { text: meta.l2_content, weight: 0.96 },
      ];
      const preTokenized = candidateFields
        .filter(c => c.text)
        .map(c => {
          const normalized = normalizeSearchText(c.text);
          return { tokens: tokenSetForSearch(normalized), weight: c.weight, normalized };
        });
      const score = scoreLexicalHitPreTokenized(queryTokens, preTokenized, normalizedQuery);

      if (score <= 0) continue;
      matches.push({ entry, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit);
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    const candidates = await this.findRowsByIdOrPrefix(id, ["id", "scope"]);
    if (candidates.length === 0) {
      return false;
    }

    const resolvedId = candidates[0].id as string;
    const rowScope = (candidates[0].scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
    }

    const result = await this.runWithFileLock(async () => {
      await this.table!.delete(`id = '${escapeSqlLiteral(resolvedId)}'`);
      return true;
    });
    this._statsCache = null;
    return result;
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];
    const safeLimit = clampInt(limit, 1, 200);
    const safeOffset = Math.max(0, Math.floor(offset));
    const neededCount = safeLimit + safeOffset;
    const baseWhere = this.buildBaseWhereClause(scopeFilter, category);
    const totalCount = await this.countRowsWithFilter(baseWhere);

    if (totalCount === 0 || safeOffset >= totalCount) return [];

    let rows: MemoryEntry[];
    if (totalCount <= neededCount * 2) {
      rows = await this.fetchListRows(baseWhere);
    } else {
      const upperExclusive = Date.now() + 1;
      const lowerBound = await this.findListWindowLowerBound(
        baseWhere,
        neededCount,
        upperExclusive,
      );
      rows = lowerBound === null
        ? await this.fetchListRows(baseWhere)
        : await this.fetchListRows(
            combineWhereClauses([
              baseWhere,
              `timestamp >= ${lowerBound}`,
              `timestamp < ${upperExclusive}`,
            ]),
          );
      if (rows.length < neededCount) {
        rows = await this.fetchListRows(baseWhere);
      }
    }

    return rows
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    memoryCategoryCounts: Record<string, number>;
    recentActivity: { last24h: number; last7d: number; last30d: number };
    tierDistribution: Record<string, number>;
    healthSignals: { badRecall: number; suppressed: number; lowConfidence: number };
  }> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      return {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
        memoryCategoryCounts: {},
        recentActivity: { last24h: 0, last7d: 0, last30d: 0 },
        tierDistribution: {},
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      };
    }

    // Check stats cache
    const cacheKey = JSON.stringify(scopeFilter ?? null);
    if (
      this._statsCache &&
      this._statsCache.key === cacheKey &&
      Date.now() - this._statsCache.ts < MemoryStore.STATS_CACHE_TTL_MS
    ) {
      return this._statsCache.result;
    }
    const whereClause = this.buildBaseWhereClause(scopeFilter);
    const now = Date.now();
    const h24 = 24 * 60 * 60 * 1000;
    const d7 = 7 * h24;
    const d30 = 30 * h24;

    // Phase 1: lightweight count queries (no row data loaded)
    const [totalCount, last24h, last7d, last30d] = await Promise.all([
      this.countRowsWithFilter(whereClause),
      this.countRowsWithFilter(combineWhereClauses([whereClause, `timestamp >= ${now - h24}`])),
      this.countRowsWithFilter(combineWhereClauses([whereClause, `timestamp >= ${now - d7}`])),
      this.countRowsWithFilter(combineWhereClauses([whereClause, `timestamp >= ${now - d30}`])),
    ]);

    if (totalCount === 0) {
      return {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
        memoryCategoryCounts: {},
        recentActivity: { last24h: 0, last7d: 0, last30d: 0 },
        tierDistribution: {},
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      };
    }

    // Phase 2: load lightweight columns (no vector) and use mapRowToMemoryEntry
    // so that parsed metadata is cached in _parsedMeta for reuse.
    let query = this.table!.query().select(LIST_ENTRY_COLUMNS as unknown as string[]);
    if (whereClause) {
      query = query.where(whereClause);
    }
    const results = await query.toArray();

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    const memoryCategoryCounts: Record<string, number> = {};
    const tierDistribution: Record<string, number> = {};
    let badRecall = 0;
    let suppressed = 0;
    let lowConfidence = 0;

    for (const row of results) {
      const entry = mapRowToMemoryEntry(row, false);
      const scope = entry.scope;
      const category = entry.category;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;

      // Use pre-parsed metadata from _parsedMeta (cached by mapRowToMemoryEntry)
      const meta = entry._parsedMeta!;
      const memoryCategory = String((meta.memory_category || category) as MemoryCategory);
      memoryCategoryCounts[memoryCategory] = (memoryCategoryCounts[memoryCategory] || 0) + 1;
      const tier = String(meta.memory_tier || meta.memory_layer || "unknown");
      tierDistribution[tier] = (tierDistribution[tier] || 0) + 1;
      if (Number(meta.bad_recall_count || 0) > 0) badRecall++;
      if (hasActiveRecallSuppression(meta)) suppressed++;
      if (typeof meta.confidence === "number" && meta.confidence < 0.4) lowConfidence++;
    }

    const result = {
      totalCount,
      scopeCounts,
      categoryCounts,
      memoryCategoryCounts,
      recentActivity: { last24h, last7d, last30d },
      tierDistribution,
      healthSignals: { badRecall, suppressed, lowConfidence },
    };

    // Cache the result
    this._statsCache = { key: cacheKey, result, ts: Date.now() };

    return result;
  }

  async update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    const result = await this.runWithFileLock(async () => {
      const rows = await this.findRowsByIdOrPrefix(id, FULL_ENTRY_COLUMNS);

      if (rows.length === 0) return null;

      const original = mapRowToMemoryEntry(rows[0]);

      // Check scope permissions
      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(original.scope)
      ) {
        throw new Error(`Memory ${id} is outside accessible scopes`);
      }

      // Build updated entry from the latest row while the write lock is held.
      const updated: MemoryEntry = {
        ...original,
        text: updates.text ?? original.text,
        vector: updates.vector ?? original.vector,
        category: updates.category ?? original.category,
        importance: updates.importance ?? original.importance,
        timestamp: original.timestamp, // preserve original
        metadata: updates.metadata ?? original.metadata,
      };

      // Use LanceDB mergeInsert for atomic upsert — eliminates the
      // delete+add race condition where a failed add could lose data.
      try {
        await this.table!
          .mergeInsert(["id"])
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(toLanceRows([updated]));
      } catch (mergeError) {
        throw new Error(
          `Failed to update memory ${id}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`,
        );
      }

      return updated;
    });

    this._statsCache = null;
    return result;
  }

  /**
   * Batch update metadata for multiple entries in a single lock acquisition.
   * Each patch specifies an ID and the new metadata string.
   * Missing IDs are silently skipped. Returns the number of entries updated.
   */
  async updateBatchMetadata(
    patches: Array<{ id: string; metadata: string }>,
  ): Promise<number> {
    await this.ensureInitialized();
    if (patches.length === 0) return 0;

    const metadataById = new Map<string, string>();
    for (const patch of patches) {
      if (typeof patch.id !== "string" || patch.id.length === 0) continue;
      metadataById.set(patch.id, patch.metadata);
    }
    if (metadataById.size === 0) return 0;

    // Read-modify-write all inside the lock to prevent TOCTOU races
    const updatedCount = await this.runWithFileLock(async () => {
      const existingRows = await this.fetchFullRowsByIds([...metadataById.keys()]);
      const updatedRows = existingRows.map((original) => ({
        ...original,
        metadata: metadataById.get(original.id) ?? original.metadata,
      }));

      if (updatedRows.length === 0) return 0;

      await this.mergeInsertEntriesInChunks(updatedRows);

      return updatedRows.length;
    });

    this._statsCache = null;
    return updatedCount;
  }


  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    // Read-modify-write all inside the lock to prevent TOCTOU races
    return this.runWithFileLock(async () => {
      const rows = await this.findRowsByIdOrPrefix(id, FULL_ENTRY_COLUMNS);

      if (rows.length === 0) return null;

      const existing = mapRowToMemoryEntry(rows[0]);

      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(existing.scope)
      ) {
        throw new Error(`Memory ${id} is outside accessible scopes`);
      }

      const metadata = buildSmartMetadata(existing, patch);
      const updated: MemoryEntry = {
        ...existing,
        metadata: stringifySmartMetadata(metadata),
      };

      try {
        await this.table!
          .mergeInsert(["id"])
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(toLanceRows([updated]));
      } catch (mergeError) {
        throw new Error(
          `Failed to patch metadata for ${id}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`,
        );
      }

      this._statsCache = null;
      return updated;
    });
  }

  /**
   * Batch patch metadata for multiple entries in a single lock acquisition.
   * Each patch specifies an ID and a MetadataPatch object.
   * Missing or scope-denied IDs are silently skipped. Returns the number updated.
   */
  async patchMetadataBatch(
    patches: Array<{ id: string; patch: MetadataPatch }>,
    scopeFilter?: string[],
  ): Promise<number> {
    await this.ensureInitialized();
    if (patches.length === 0) return 0;

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return 0;

    const patchById = new Map<string, MetadataPatch>();
    for (const { id, patch } of patches) {
      if (typeof id !== "string" || id.length === 0) continue;
      patchById.set(id, { ...(patchById.get(id) ?? {}), ...patch });
    }
    if (patchById.size === 0) return 0;

    const updatedCount = await this.runWithFileLock(async () => {
      const existingRows = await this.fetchFullRowsByIds([...patchById.keys()]);
      const updatedRows: MemoryEntry[] = [];

      for (const existing of existingRows) {
        if (
          scopeFilter &&
          scopeFilter.length > 0 &&
          !scopeFilter.includes(existing.scope)
        ) {
          continue;
        }

        const patch = patchById.get(existing.id);
        if (!patch) continue;
        const metadata = buildSmartMetadata(existing, patch);
        updatedRows.push({
          ...existing,
          metadata: stringifySmartMetadata(metadata),
        });
      }

      if (updatedRows.length === 0) return 0;

      try {
        await this.mergeInsertEntriesInChunks(updatedRows);
      } catch (mergeError) {
        throw new Error(
          `Failed to batch-patch metadata: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`,
        );
      }

      return updatedRows.length;
    });

    this._statsCache = null;
    return updatedCount;
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    await this.ensureInitialized();

    const conditions: string[] = [];

    if (scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`(${scopeConditions})`);
    }

    if (beforeTimestamp !== undefined) {
      conditions.push(`timestamp < ${beforeTimestamp}`);
    }

    if (conditions.length === 0) {
      throw new Error(
        "Bulk delete requires at least scope or timestamp filter for safety",
      );
    }

    const whereClause = conditions.join(" AND ");

    const result = await this.runWithFileLock(async () => {
      const beforeCount = await this.table!.countRows(whereClause);

      if (beforeCount > 0) {
        await this.table!.delete(whereClause);
      }
      const afterCount = await this.table!.countRows(whereClause);

      return Math.max(0, beforeCount - afterCount);
    });

    this._statsCache = null;
    return result;
  }

  /** Release database and table references, clearing caches. */
  close(): void {
    this.table = null;
    this.db = null;
    this._statsCache = null;
  }

  async getIndexStatus(): Promise<StoreIndexStatus> {
    await this.ensureInitialized();
    return this.getIndexStatusInternal(this.table!);
  }

  get hasFtsSupport(): boolean {
    return this.ftsIndexCreated;
  }

  /** Last FTS error for diagnostics */
  private _lastFtsError: string | null = null;

  get lastFtsError(): string | null {
    return this._lastFtsError;
  }

  /** Get FTS index health status */
  getFtsStatus(): { available: boolean; lastError: string | null } {
    return {
      available: this.ftsIndexCreated,
      lastError: this._lastFtsError,
    };
  }

  /** Rebuild FTS index (drops and recreates). Useful for recovery after corruption. */
  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized();
    try {
      // Drop existing FTS index if any
      const indices = await this.table!.listIndices();
      for (const idx of indices) {
        if (idx.indexType === "FTS" || idx.columns?.includes("text")) {
          try {
            await this.table!.dropIndex((idx as LanceIndex).name || "text");
          } catch (err) {
            this.log.warn(`dropIndex(${(idx as LanceIndex).name || "text"}) failed:`, err);
          }
        }
      }
      // Recreate
      this.ftsIndexCreated = false;
      await this.createFtsIndex(this.table!, { force: true });
      await this.getIndexStatusInternal(this.table!);
      this._lastFtsError = null;
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastFtsError = msg;
      this.ftsIndexCreated = false;
      return { success: false, error: msg };
    }
  }

  /**
   * Fetch memories older than `maxTimestamp` including their raw vectors.
   * Used exclusively by the memory compactor; vectors are intentionally
   * omitted from `list()` for performance, but compaction needs them for
   * cosine-similarity clustering.
   */
  async fetchForCompaction(
    maxTimestamp: number,
    scopeFilter?: string[],
    limit = 200,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const conditions: string[] = [`timestamp < ${maxTimestamp}`];

    const scopeWhere = buildScopeWhereClause(scopeFilter);
    if (scopeWhere) conditions.push(scopeWhere);

    const whereClause = conditions.join(" AND ");

    const results = await this.table!
      .query()
      .select(FULL_ENTRY_COLUMNS as unknown as string[])
      .where(whereClause)
      .limit(limit)
      .toArray();

    return results.map((row) => mapRowToMemoryEntry(row));
  }
}
