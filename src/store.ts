/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSmartMetadata, isMemoryActiveAt, stringifySmartMetadata } from "./smart-metadata.js";
import { clampInt } from "./utils.js";
import { createLogger, type Logger } from "./logger.js";

import type { MemoryEntry, MemorySearchResult, StoreConfig, MetadataPatch, StoreIndexStatus } from "./store-types.js";
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
  scoreLexicalHit,
  resolveMemoryId,
} from "./store-sql-utils.js";
import { toLanceRows, toNumberVector, mapRowToMemoryEntry } from "./store-row-mappers.js";
import { loadLanceDB } from "./lancedb-loader.js";
import { validateStoragePath } from "./storage-path.js";

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

let lockfileModule: any = null;

async function loadLockfile(): Promise<any> {
  if (!lockfileModule) {
    lockfileModule = await import("proper-lockfile");
  }
  return lockfileModule;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

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

  // In-process serialization chain (Issue #598)
  private _serialChain: Promise<void> = Promise.resolve();

  /** Logger instance for structured logging. */
  private log: Logger;

  /** Enter batch mode — subsequent store() calls buffer instead of writing immediately. */
  startBatch(): void {
    this._batchActive = true;
  }

  /**
   * Serialize concurrent async operations through a promise chain.
   * Each call waits for the previous one to complete before executing.
   * Prevents unbounded memory growth by cleaning up resolved promises.
   */
  async runSerializedUpdate<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._serialChain;
    let resolve: () => void;
    this._serialChain = new Promise<void>((r) => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  /**
   * Flush all buffered entries in a single lock acquisition.
   * Returns the written entries. Exits batch mode afterwards.
   * If no entries buffered, exits batch mode and returns empty array (no lock acquired).
   */
  async flushBatch(): Promise<MemoryEntry[]> {
    this._batchActive = false;
    const entries = this._batchBuffer;
    this._batchBuffer = [];
    if (entries.length === 0) return [];

    await this.ensureInitialized();
    const written = await this.runWithFileLock(async () => {
      try {
        await this.table!.add(toLanceRows(entries));
      } catch (err: any) {
        const code = err.code || "";
        const message = err.message || String(err);
        throw new Error(
          `Failed to flush-batch store ${entries.length} memories: ${code} ${message}`,
        );
      }
      return entries;
    });
    await this.maybeCreateDeferredVectorIndex();
    return written;
  }

  constructor(private readonly config: StoreConfig) {
    this.log = config.logger ?? createLogger();
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

    const lancedb = await loadLanceDB();
    const config =
      kind === "bitmap"
        ? (lancedb as any).Index.bitmap()
        : (lancedb as any).Index.btree();
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

    const lancedb = await loadLanceDB();
    await table.createIndex("vector", {
      config: (lancedb as any).Index.ivfFlat({
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

  private async runWithFileLock<T>(fn: () => Promise<T>): Promise<T> {
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
    // Uses async I/O and handles ENOENT from concurrent cleanup by another process.
    try {
      const stat = await statAsync(lockPath);
      if (stat) {
        const ageMs = Date.now() - Number(stat.mtimeMs);
        const staleThresholdMs = 5 * 60 * 1000;
        if (ageMs > staleThresholdMs) {
          try {
            await unlink(lockPath);
            this.log.warn(`cleared stale lock: ${lockPath} ageMs=${ageMs}`);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              this.log.warn(`failed to remove stale lock: ${lockPath}: ${err}`);
            }
          }
        }
      }
    } catch {
      // Lock file doesn't exist or can't be read — proceed normally
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
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
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
    } catch (_openErr) {
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

  private async createFtsIndex(table: LanceDB.Table): Promise<void> {
    try {
      // Check if FTS index already exists
      const indices = await table.listIndices();
      const existingFts = indices?.find(
        (idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );

      const lancedb = await loadLanceDB();
      const ftsConfig = (lancedb as any).Index.fts({
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
        // Migrate: drop old index (may have been created with "simple" tokenizer)
        // and recreate with ngram tokenizer for CJK support.
        try {
          await table.dropIndex((existingFts as any).name || "text");
        } catch (err) {
          this.log.warn(`dropIndex for FTS migration failed: ${err}`);
        }
      }

      await table.createIndex("text", {
        config: ftsConfig,
        replace: true,
        waitTimeoutSeconds: 60,
      });
    } catch (err) {
      throw new Error(
        `FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`,
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

    // Batch mode: buffer for later flush instead of acquiring lock per entry
    if (this._batchActive) {
      this._batchBuffer.push(fullEntry);
      return fullEntry;
    }

    const stored = await this.runWithFileLock(async () => {
      try {
        await this.table!.add(toLanceRows([fullEntry]));
      } catch (err: any) {
        const code = err.code || "";
        const message = err.message || String(err);
        throw new Error(
          `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`,
        );
      }
      return fullEntry;
    });
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

    for (const row of rows) {
      const entry = mapRowToMemoryEntry(row, false);
      const meta = entry._parsedMeta!;

      // Skip inactive (superseded) records when requested
      if (options?.excludeInactive && !isMemoryActiveAt(meta)) {
        continue;
      }

      const score = scoreLexicalHit(trimmedQuery, [
        { text: entry.text, weight: 1 },
        { text: meta.l0_abstract, weight: 0.98 },
        { text: meta.l1_overview, weight: 0.92 },
        { text: meta.l2_content, weight: 0.96 },
      ]);

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

    const resolved = resolveMemoryId(id);

    let candidates: any[];
    if (resolved.isFullId) {
      const safeId = escapeSqlLiteral(id);
      candidates = await this.table!.query()
        .select(["id", "scope"])
        .where(`id = '${safeId}'`)
        .limit(1)
        .toArray();
    } else {
      candidates = await this.table!.query()
        .select(["id", "scope"])
        .where(prefixWhereClause("id", id))
        .limit(2)
        .toArray();
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }
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

    return this.runWithFileLock(async () => {
      await this.table!.delete(`id = '${resolvedId}'`);
      return true;
    });
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
    recentActivity: { last24h: number; last7d: number };
    tierDistribution: Record<string, number>;
    healthSignals: { badRecall: number; suppressed: number; lowConfidence: number };
  }> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      return {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
        recentActivity: { last24h: 0, last7d: 0 },
        tierDistribution: {},
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      };
    }
    const whereClause = this.buildBaseWhereClause(scopeFilter);
    const now = Date.now();
    const h24 = 24 * 60 * 60 * 1000;
    const d7 = 7 * h24;

    // Phase 1: lightweight count queries (no row data loaded)
    const [totalCount, last24h, last7d] = await Promise.all([
      this.countRowsWithFilter(whereClause),
      this.countRowsWithFilter(combineWhereClauses([whereClause, `timestamp >= ${now - h24}`])),
      this.countRowsWithFilter(combineWhereClauses([whereClause, `timestamp >= ${now - d7}`])),
    ]);

    if (totalCount === 0) {
      return {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
        recentActivity: { last24h: 0, last7d: 0 },
        tierDistribution: {},
        healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
      };
    }

    // Phase 2: load only the lightweight columns (no vector, no text, no id)
    let query = this.table!.query().select(["scope", "category", "timestamp", "metadata"]);
    if (whereClause) {
      query = query.where(whereClause);
    }
    const results = await query.toArray();

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    const tierDistribution: Record<string, number> = {};
    let badRecall = 0;
    let suppressed = 0;
    let lowConfidence = 0;

    for (const row of results) {
      const scope = (row.scope as string | undefined) ?? "global";
      const category = row.category as string;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;

      // Parse metadata for lifecycle and health signals
      try {
        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : {};
        const tier = meta.memory_tier || meta.memory_layer || "unknown";
        tierDistribution[tier] = (tierDistribution[tier] || 0) + 1;
        if (Number(meta.bad_recall_count || 0) > 0) badRecall++;
        if (Number(meta.suppressed_until_turn || 0) > 0) suppressed++;
        if (typeof meta.confidence === "number" && meta.confidence < 0.4) lowConfidence++;
      } catch {
        // skip malformed metadata
      }
    }

    return {
      totalCount,
      scopeCounts,
      categoryCounts,
      recentActivity: { last24h, last7d },
      tierDistribution,
      healthSignals: { badRecall, suppressed, lowConfidence },
    };
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

    return this.runWithFileLock(async () => {
      const resolved = resolveMemoryId(id);

      let rows: any[];
      if (resolved.isFullId) {
        const safeId = escapeSqlLiteral(id);
        rows = await this.table!.query()
          .select(FULL_ENTRY_COLUMNS as unknown as string[])
          .where(`id = '${safeId}'`)
          .limit(1)
          .toArray();
      } else {
        rows = await this.table!.query()
          .select(FULL_ENTRY_COLUMNS as unknown as string[])
          .where(prefixWhereClause("id", id))
          .limit(2)
          .toArray();
        if (rows.length > 1) {
          throw new Error(
            `Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`,
          );
        }
      }

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

      // Build updated entry, preserving original timestamp
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

    return this.runWithFileLock(async () => {
      const updatedRows: MemoryEntry[] = [];

      for (const patch of patches) {
        const safeId = escapeSqlLiteral(patch.id);
        const rows = await this.table!
          .query()
          .select(FULL_ENTRY_COLUMNS as unknown as string[])
          .where(`id = '${safeId}'`)
          .limit(1)
          .toArray();

        if (rows.length === 0) continue; // entry deleted or not found
        const original = mapRowToMemoryEntry(rows[0]);
        updatedRows.push({ ...original, metadata: patch.metadata });
      }

      if (updatedRows.length === 0) return 0;

      // Single mergeInsert for all updated rows
      await this.table!
        .mergeInsert(["id"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(toLanceRows(updatedRows));

      return updatedRows.length;
    });
  }


  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    const existing = await this.getById(id, scopeFilter);
    if (!existing) return null;

    const metadata = buildSmartMetadata(existing, patch);
    return this.update(
      id,
      { metadata: stringifySmartMetadata(metadata) },
      scopeFilter,
    );
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

    if (beforeTimestamp) {
      conditions.push(`timestamp < ${beforeTimestamp}`);
    }

    if (conditions.length === 0) {
      throw new Error(
        "Bulk delete requires at least scope or timestamp filter for safety",
      );
    }

    const whereClause = conditions.join(" AND ");

    return this.runWithFileLock(async () => {
      const beforeCount = await this.table!.countRows(whereClause);

      if (beforeCount > 0) {
        await this.table!.delete(whereClause);
      }
      const afterCount = await this.table!.countRows(whereClause);

      return Math.max(0, beforeCount - afterCount);
    });
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
            await this.table!.dropIndex((idx as any).name || "text");
          } catch (err) {
            this.log.warn(`dropIndex(${(idx as any).name || "text"}) failed:`, err);
          }
        }
      }
      // Recreate
      await this.createFtsIndex(this.table!);
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
