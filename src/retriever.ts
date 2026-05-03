/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { AccessTracker } from "./access-tracker.js";
import { filterNoise } from "./noise-filter.js";
import { expandQuery } from "./query-expander.js";
import type { DecayEngine, DecayableMemory } from "./decay-engine.js";
import { RecencyEngine } from "./recency-engine.js";
import type { TierManager } from "./tier-manager.js";
import {
  getDecayableFromEntry,
  isMemoryExpired,
  parseSmartMetadata,
} from "./smart-metadata.js";
import { TraceCollector, type RetrievalTrace } from "./retrieval-trace.js";
import { RetrievalStatsCollector } from "./retrieval-stats.js";
import { clampInt } from "./utils.js";
import type { Logger } from "./logger.js";

import type {
  RetrievalConfig,
  RetrievalContext,
  RetrievalResult,
  RetrievalDiagnostics,
  RetrieverLifecycleOptions,
} from "./retriever-types.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  fallbackRetrieverLogger,
} from "./retriever-types.js";

import {
  buildDropSummary,
  attachFailureStage,
  extractFailureStage,
  throwIfAborted,
  resolveUnlessAborted,
} from "./retriever-utils.js";

import { rerankResults } from "./reranker.js";
import { fuseResults } from "./rrf-fusion.js";
import {
  applyRecencyComposite,
  applyDecayBoost,
  applyLengthNormalization,
  applyTimeDecay,
  applyFallbackScoring,
} from "./temporal-scoring.js";
import { applyMMRDiversity } from "./mmr-diversity.js";

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-export all types for backward compatibility
export type {
  RetrievalConfig,
  RetrievalContext,
  RetrievalResult,
  RetrievalDiagnostics,
  RetrieverLifecycleOptions,
} from "./retriever-types.js";
export { DEFAULT_RETRIEVAL_CONFIG } from "./retriever-types.js";

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private accessTracker: AccessTracker | null = null;
  private lastDiagnostics: RetrievalDiagnostics | null = null;
  private tierManager: TierManager | null = null;
  private _statsCollector: RetrievalStatsCollector | null = null;
  private recencyEngine: RecencyEngine | null = null;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    private decayEngine: DecayEngine | null = null,
    private logger: Pick<Logger, "debug" | "warn"> = fallbackRetrieverLogger,
  ) { }

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  setTierManager(manager: TierManager): void {
    this.tierManager = manager;
  }

  /** Set the lightweight RecencyEngine (used when DecayEngine is not configured). */
  setRecencyEngine(engine: RecencyEngine): void {
    this.recencyEngine = engine;
  }

  /** Enable aggregate retrieval statistics collection. */
  setStatsCollector(collector: RetrievalStatsCollector): void {
    this._statsCollector = collector;
  }

  /** Get the stats collector (if set). */
  getStatsCollector(): RetrievalStatsCollector | null {
    return this._statsCollector;
  }

  /**
   * Compute a confidence score (0-1) for a retrieval result.
   * Combines multiple signals:
   * - Retrieval score (primary signal)
   * - Recency (newer memories score higher)
   * - Access count (frequently accessed memories are more reliable)
   * - Confidence from metadata (self-reported confidence)
   */
  private computeConfidence(result: RetrievalResult): number {
    const meta = result.entry._parsedMeta;
    if (!meta) return Math.min(1, result.score);

    // Base: retrieval score (0-1)
    const baseScore = Math.min(1, Math.max(0, result.score));

    // Recency: exponential decay, half-life = 30 days
    const ageMs = Date.now() - (result.entry.timestamp || 0);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.exp(-0.693 * ageDays / 30); // ln(2)/30

    // Access frequency: log scale, saturates at ~10 accesses
    const accessCount = meta.access_count || 0;
    const accessFactor = Math.min(1, Math.log2(1 + accessCount) / 3.32); // log2(10) ≈ 3.32

    // Metadata confidence (self-reported)
    const metaConfidence = meta.confidence || 0.7;

    // Weighted combination
    const confidence =
      baseScore * 0.5 +
      recencyFactor * 0.2 +
      accessFactor * 0.15 +
      metaConfidence * 0.15;

    return Math.min(1, Math.max(0, confidence));
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category, source, signal, candidatePoolSize, overFetchMultiplier, degradeAfterMs, deadlineAt } = context;
    const safeLimit = clampInt(limit, 1, 20);
    this.lastDiagnostics = null;
    const diagnostics: RetrievalDiagnostics = {
      source,
      mode: this.config.mode,
      originalQuery: query,
      bm25Query: this.config.mode === "vector" ? null : query,
      queryExpanded: false,
      limit: safeLimit,
      scopeFilter: scopeFilter ? [...scopeFilter] : undefined,
      category,
      vectorResultCount: 0,
      bm25ResultCount: 0,
      fusedResultCount: 0,
      finalResultCount: 0,
      latencyMs: {},
      stageCounts: {
        afterMinScore: 0,
        rerankInput: 0,
        afterRerank: 0,
        afterRecency: 0,
        afterImportance: 0,
        afterLengthNorm: 0,
        afterTimeDecay: 0,
        afterHardMinScore: 0,
        afterNoiseFilter: 0,
        afterDiversity: 0,
      },
      dropSummary: [],
    };
    this.lastDiagnostics = diagnostics;

    try {
      // Create trace only when stats collector is active (zero overhead otherwise)
      const trace = this._statsCollector ? new TraceCollector() : undefined;

      // Check if query contains tag prefixes -> use BM25-only + mustContain
      const tagTokens = this.extractTagTokens(query);
      let results: RetrievalResult[];
      if (tagTokens.length > 0) {
        results = await this.bm25OnlyRetrieval(
          query,
          tagTokens,
          safeLimit,
          scopeFilter,
          category,
          trace,
          diagnostics,
        );
      } else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
        results = await this.vectorOnlyRetrieval(
          query,
          safeLimit,
          scopeFilter,
          category,
          trace,
          diagnostics,
          signal,
          candidatePoolSize,
          overFetchMultiplier,
        );
      } else {
        results = await this.hybridRetrieval(
          query,
          safeLimit,
          scopeFilter,
          category,
          trace,
          source,
          diagnostics,
          signal,
          candidatePoolSize,
          overFetchMultiplier,
          degradeAfterMs,
          deadlineAt,
        );
      }

      diagnostics.finalResultCount = results.length;
      delete diagnostics.currentStage;
      delete diagnostics.currentStageStartedAt;
      delete diagnostics.latencyMs;
      diagnostics.dropSummary = buildDropSummary(diagnostics);
      this.lastDiagnostics = diagnostics;

      if (trace && this._statsCollector) {
        const mode = tagTokens.length > 0
          ? "bm25"
          : (this.config.mode === "vector" || !this.store.hasFtsSupport)
            ? "vector"
            : "hybrid";
        const finalTrace = trace.finalize(query, mode);
        this._statsCollector.recordQuery(finalTrace, source || "unknown");
      }

      if (source === "manual" && results.length > 0) {
        void this.recordAccessAndMaybeTransition(results).catch((err) =>
          this.logger.debug(`[Retriever] recordAccessAndMaybeTransition failed: ${err}`),
        );
      }

      // Record access for reinforcement (manual recall only)
      if (this.accessTracker && source === "manual" && results.length > 0) {
        this.accessTracker.recordAccess(results.map((r) => r.entry.id));
      }

      return results;
    } catch (error) {
      diagnostics.finalResultCount = 0;
      diagnostics.dropSummary = buildDropSummary(diagnostics);
      diagnostics.errorMessage =
        error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        delete diagnostics.currentStage;
        delete diagnostics.currentStageStartedAt;
      }
      if (diagnostics.latencyMs && Object.keys(diagnostics.latencyMs).length === 0) {
        delete diagnostics.latencyMs;
      }
      this.lastDiagnostics = diagnostics;
      throw error;
    }
  }

  /**
   * Retrieve with full trace, used by the mymem_debug tool.
   * Always collects a trace regardless of stats collector state.
   */
  async retrieveWithTrace(
    context: RetrievalContext,
  ): Promise<{ results: RetrievalResult[]; trace: RetrievalTrace }> {
    const { query, limit, scopeFilter, category, source } = context;
    const safeLimit = clampInt(limit, 1, 20);
    const trace = new TraceCollector();

    const tagTokens = this.extractTagTokens(query);
    let results: RetrievalResult[];

    if (tagTokens.length > 0) {
      results = await this.bm25OnlyRetrieval(
        query, tagTokens, safeLimit, scopeFilter, category, trace,
      );
    } else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
      results = await this.vectorOnlyRetrieval(
        query, safeLimit, scopeFilter, category, trace,
      );
    } else {
      results = await this.hybridRetrieval(
        query, safeLimit, scopeFilter, category, trace,
      );
    }

    const mode = tagTokens.length > 0 ? "bm25"
      : (this.config.mode === "vector" || !this.store.hasFtsSupport) ? "vector" : "hybrid";
    const finalTrace = trace.finalize(query, mode);

    if (this._statsCollector) {
      this._statsCollector.recordQuery(finalTrace, source || "debug");
    }

    if (source === "manual" && results.length > 0) {
      void this.recordAccessAndMaybeTransition(results).catch((err) =>
        this.logger.debug(`[Retriever] recordAccessAndMaybeTransition failed: ${err}`),
      );
    }

    if (this.accessTracker && source === "manual" && results.length > 0) {
      this.accessTracker.recordAccess(results.map((r) => r.entry.id));
    }

    return { results, trace: finalTrace };
  }

  private extractTagTokens(query: string): string[] {
    if (!this.config.tagPrefixes?.length) return [];

    const pattern = this.config.tagPrefixes
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0)
      .map(escapeRegExp)
      .join("|");
    if (!pattern) return [];
    const regex = new RegExp(`(?:${pattern}):[\\w-]+`, "gi");
    const matches = query.match(regex);
    return matches || [];
  }

  /**
   * Shared post-processing pipeline for all retrieval modes.
   * Applies temporal scoring, length normalization, hard min-score filter,
   * optional time decay, noise filtering, sort, MMR diversity, and confidence.
   */
  private async applyPostProcessingPipeline(
    results: RetrievalResult[],
    limit: number,
    options: {
      skipTimeDecay?: boolean;
      trace?: TraceCollector;
      diagnostics?: RetrievalDiagnostics;
      preserveWhenHardFiltered?: boolean;
    } = {},
  ): Promise<RetrievalResult[]> {
    const {
      skipTimeDecay = false,
      trace,
      diagnostics,
      preserveWhenHardFiltered = false,
    } = options;

    // 1. Temporal scoring (mutually exclusive engines)
    let temporallyRanked: RetrievalResult[];
    if (this.decayEngine) {
      temporallyRanked = results;
    } else if (this.recencyEngine) {
      if (trace) trace.startStage("recency_composite", results.map((r) => r.entry.id));
      temporallyRanked = applyRecencyComposite(results, this.recencyEngine);
      if (trace) trace.endStage(temporallyRanked.map((r) => r.entry.id), temporallyRanked.map((r) => r.score));
    } else {
      if (trace) trace.startStage("fallback_scoring", results.map((r) => r.entry.id));
      temporallyRanked = applyFallbackScoring(results, this.config);
      if (trace) trace.endStage(temporallyRanked.map((r) => r.entry.id), temporallyRanked.map((r) => r.score));
    }
    if (diagnostics) {
      diagnostics.stageCounts.afterRecency = temporallyRanked.length;
      diagnostics.stageCounts.afterImportance = temporallyRanked.length;
    }

    // 2. Length normalization
    if (trace) trace.startStage("length_normalization", temporallyRanked.map((r) => r.entry.id));
    const lengthNormalized = applyLengthNormalization(temporallyRanked, this.config.lengthNormAnchor);
    if (trace) trace.endStage(lengthNormalized.map((r) => r.entry.id), lengthNormalized.map((r) => r.score));
    if (diagnostics) diagnostics.stageCounts.afterLengthNorm = lengthNormalized.length;

    // 3. Hard min-score filter
    if (trace) trace.startStage("hard_cutoff", lengthNormalized.map((r) => r.entry.id));
    const strictHardFiltered = lengthNormalized.filter((r) => r.score >= this.config.hardMinScore);
    const hardFiltered =
      preserveWhenHardFiltered && strictHardFiltered.length === 0 && lengthNormalized.length > 0
        ? lengthNormalized
        : strictHardFiltered;
    if (trace) trace.endStage(hardFiltered.map((r) => r.entry.id), hardFiltered.map((r) => r.score));
    if (diagnostics) diagnostics.stageCounts.afterHardMinScore = hardFiltered.length;

    // 4. Lifecycle scoring. DecayEngine replaces ordinary time decay, but it still
    // needs to run here because the first temporal stage intentionally leaves
    // decay-aware scoring untouched.
    let lifecycleRanked: RetrievalResult[];
    if (this.decayEngine) {
      if (trace) trace.startStage("decay_boost", hardFiltered.map((r) => r.entry.id));
      lifecycleRanked = applyDecayBoost(hardFiltered, this.decayEngine);
      if (trace) trace.endStage(lifecycleRanked.map((r) => r.entry.id), lifecycleRanked.map((r) => r.score));
    } else if (skipTimeDecay) {
      lifecycleRanked = hardFiltered;
    } else {
      if (trace) trace.startStage("time_decay", hardFiltered.map((r) => r.entry.id));
      lifecycleRanked = applyTimeDecay(hardFiltered, this.config);
      if (trace) trace.endStage(lifecycleRanked.map((r) => r.entry.id), lifecycleRanked.map((r) => r.score));
    }
    if (diagnostics) diagnostics.stageCounts.afterTimeDecay = lifecycleRanked.length;

    // 5. Noise filter
    if (trace) trace.startStage("noise_filter", lifecycleRanked.map((r) => r.entry.id));
    let denoised: RetrievalResult[];
    if (this.config.filterNoise) {
      denoised = filterNoise(lifecycleRanked, (r) => r.entry.text);
    } else {
      denoised = lifecycleRanked;
    }
    if (trace) trace.endStage(denoised.map((r) => r.entry.id), denoised.map((r) => r.score));
    if (diagnostics) diagnostics.stageCounts.afterNoiseFilter = denoised.length;

    // 6. Sort once after all scoring
    if (trace) trace.startStage("mmr_diversity", denoised.map((r) => r.entry.id));
    denoised.sort((a, b) => b.score - a.score);
    const deduplicated = applyMMRDiversity(denoised);
    const finalResults = deduplicated.slice(0, limit);

    // 7. Confidence scores
    for (const result of finalResults) {
      result.confidence = this.computeConfidence(result);
    }

    if (trace) trace.endStage(finalResults.map((r) => r.entry.id), finalResults.map((r) => r.score));
    if (diagnostics) diagnostics.stageCounts.afterDiversity = deduplicated.length;

    return finalResults;
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    trace?: TraceCollector,
    diagnostics?: RetrievalDiagnostics,
    signal?: AbortSignal,
    candidatePoolSizeOverride?: number,
    overFetchMultiplier?: number,
  ): Promise<RetrievalResult[]> {
    let failureStage: RetrievalDiagnostics["failureStage"] = "vector.embedQuery";
    const markStage = (stage: NonNullable<RetrievalDiagnostics["failureStage"]>) => {
      failureStage = stage;
      if (diagnostics) {
        diagnostics.currentStage = stage;
        diagnostics.currentStageStartedAt = Date.now();
      }
    };
    try {
      const candidatePoolSize = candidatePoolSizeOverride
        ? clampInt(candidatePoolSizeOverride, limit, 100)
        : Math.max(this.config.candidatePoolSize, limit * 2);
      markStage("vector.embedQuery");
      const t0 = Date.now();
      const queryVector = await this.embedder.embedQuery(query, signal);
      if (diagnostics?.latencyMs) diagnostics.latencyMs.embedQuery = Date.now() - t0;
      markStage("vector.vectorSearch");
      const t1 = Date.now();
      const results = await this.store.vectorSearch(
        queryVector,
        candidatePoolSize,
        this.config.minScore,
        scopeFilter,
        { excludeInactive: true, overFetchMultiplier },
      );
      if (diagnostics?.latencyMs) diagnostics.latencyMs.vectorSearch = Date.now() - t1;

      const filtered = category
        ? results.filter((r) => r.entry.category === category)
        : results;

      // Filter expired memories early — before scoring — so they don't
      // occupy candidate slots that should go to live memories.
      const unexpired = filtered.filter((r) => {
        return !isMemoryExpired(r.entry._parsedMeta ?? parseSmartMetadata(r.entry.metadata, r.entry));
      });
      if (diagnostics) {
        diagnostics.vectorResultCount = unexpired.length;
        diagnostics.fusedResultCount = unexpired.length;
        diagnostics.stageCounts.afterMinScore = unexpired.length;
        diagnostics.stageCounts.rerankInput = unexpired.length;
      }

      const mapped = unexpired.map(
        (result, index) =>
          ({
            ...result,
            sources: {
              vector: { score: result.score, rank: index + 1 },
            },
          }) as RetrievalResult,
      );

      markStage("vector.postProcess");
      const skipTimeDecay = !!(this.decayEngine || this.recencyEngine);
      const finalResults = await this.applyPostProcessingPipeline(mapped, limit, {
        skipTimeDecay,
        trace,
        diagnostics,
      });
      if (diagnostics) diagnostics.stageCounts.afterRerank = mapped.length;
      return finalResults;
    } catch (error) {
      if (diagnostics) {
        diagnostics.failureStage = extractFailureStage(error) ?? failureStage;
      }
      throw error;
    }
  }

  private async bm25OnlyRetrieval(
    query: string,
    tagTokens: string[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
    trace?: TraceCollector,
    diagnostics?: RetrievalDiagnostics,
  ): Promise<RetrievalResult[]> {
    const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);

    trace?.startStage("bm25_search", []);
    const bm25Results = await this.store.bm25Search(
      query,
      candidatePoolSize,
      scopeFilter,
      { excludeInactive: true },
    );
    const categoryFiltered = category
      ? bm25Results.filter((r) => r.entry.category === category)
      : bm25Results;
    const mustContainFiltered = categoryFiltered.filter((r) => {
      const textLower = r.entry.text.toLowerCase();
      return tagTokens.every((t) => textLower.includes(t.toLowerCase()));
    });
    // Filter expired memories early — before scoring
    const unexpiredResults = mustContainFiltered.filter((r) => {
      return !isMemoryExpired(r.entry._parsedMeta ?? parseSmartMetadata(r.entry.metadata, r.entry));
    });
    const mapped = unexpiredResults.map(
      (result, index) =>
        ({
          ...result,
          sources: { bm25: { score: result.score, rank: index + 1 } },
        }) as RetrievalResult,
    );
    trace?.endStage(mapped.map((r) => r.entry.id), mapped.map((r) => r.score));
    if (diagnostics) {
      diagnostics.bm25Query = query;
      diagnostics.bm25ResultCount = mapped.length;
      diagnostics.fusedResultCount = mapped.length;
      diagnostics.stageCounts.afterMinScore = mapped.length;
      diagnostics.stageCounts.rerankInput = mapped.length;
      diagnostics.stageCounts.afterRerank = mapped.length;
    }

    const skipTimeDecay = !!(this.decayEngine || this.recencyEngine);
    return this.applyPostProcessingPipeline(mapped, limit, {
      skipTimeDecay,
      trace,
      diagnostics,
    });
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    trace?: TraceCollector,
    source?: RetrievalContext["source"],
    diagnostics?: RetrievalDiagnostics,
    signal?: AbortSignal,
    candidatePoolSizeOverride?: number,
    overFetchMultiplier?: number,
    degradeAfterMs?: number,
    deadlineAt?: number,
  ): Promise<RetrievalResult[]> {
    let failureStage: RetrievalDiagnostics["failureStage"] = "hybrid.embedQuery";
    const retrievalStartedAt = Date.now();
    const softDegradeAfterMs = source === "auto-recall" && typeof degradeAfterMs === "number" && degradeAfterMs > 0
      ? degradeAfterMs
      : undefined;
    const softDegradeAt = softDegradeAfterMs ? retrievalStartedAt + softDegradeAfterMs : undefined;
    void deadlineAt; // reserved for future deadline-aware diagnostics; hard timeout still comes from AbortSignal
    const markStage = (stage: NonNullable<RetrievalDiagnostics["failureStage"]>) => {
      failureStage = stage;
      if (diagnostics) {
        diagnostics.currentStage = stage;
        diagnostics.currentStageStartedAt = Date.now();
      }
    };
    const markDegraded = (reason: NonNullable<RetrievalDiagnostics["degradedReason"]>) => {
      if (!diagnostics) return;
      diagnostics.degraded = true;
      if (!diagnostics.degradedReason || diagnostics.degradedReason === "degrade_after_ms") {
        diagnostics.degradedReason = reason;
      }
    };
    const hasSoftDegraded = () => softDegradeAt !== undefined && Date.now() >= softDegradeAt;
    const softDegradeDelay = <T>(value: T, remainingMs: number): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), Math.max(0, remainingMs)));

    try {
      const candidatePoolSize = candidatePoolSizeOverride
        ? clampInt(candidatePoolSizeOverride, limit, 100)
        : Math.max(this.config.candidatePoolSize, limit * 2);
      const cancelSearchOnAbort = source !== "manual" && source !== "cli";
      markStage("hybrid.embedQuery");
      const t0 = Date.now();
      const bm25Query = this.buildBM25Query(query, source);
      if (diagnostics) {
        diagnostics.bm25Query = bm25Query;
        diagnostics.queryExpanded = bm25Query !== query;
      }

      trace?.startStage("parallel_search", []);
      markStage("hybrid.parallelSearch");
      const t1 = Date.now();
      type BackendResult = Array<MemorySearchResult & { rank: number }>;
      type TrackedBackendResult = {
        settled: PromiseSettledResult<BackendResult> | null;
      };
      const vectorTracker: TrackedBackendResult = { settled: null };
      const bm25Tracker: TrackedBackendResult = { settled: null };

      const bm25SearchPromise = (async () => {
        const startedAt = Date.now();
        try {
          return await this.runBM25Search(
            bm25Query,
            candidatePoolSize,
            scopeFilter,
            category,
            overFetchMultiplier,
          );
        } finally {
          if (diagnostics?.latencyMs) diagnostics.latencyMs.bm25Search = Date.now() - startedAt;
        }
      })().then(
        (value) => {
          bm25Tracker.settled = { status: "fulfilled", value };
          return value;
        },
        (reason) => {
          bm25Tracker.settled = { status: "rejected", reason };
          throw reason;
        },
      );

      let queryVector: number[] | undefined;

      const vectorSearchPromise = (async () => {
        const vector = await this.embedder.embedQuery(query, cancelSearchOnAbort ? signal : undefined);
        queryVector = vector;
        if (diagnostics?.latencyMs) diagnostics.latencyMs.embedQuery = Date.now() - t0;
        const startedAt = Date.now();
        try {
          return await this.runVectorSearch(
            vector,
            candidatePoolSize,
            scopeFilter,
            category,
            overFetchMultiplier,
          );
        } finally {
          if (diagnostics?.latencyMs) diagnostics.latencyMs.vectorSearch = Date.now() - startedAt;
        }
      })().then(
        (value) => {
          vectorTracker.settled = { status: "fulfilled", value };
          return value;
        },
        (reason) => {
          vectorTracker.settled = { status: "rejected", reason };
          throw reason;
        },
      );

      const allSearchSettledPromise = Promise.allSettled([
        vectorSearchPromise,
        bm25SearchPromise,
      ]);
      const hasUsableSettledResult = () =>
        (vectorTracker.settled?.status === "fulfilled" && vectorTracker.settled.value.length > 0) ||
        (bm25Tracker.settled?.status === "fulfilled" && bm25Tracker.settled.value.length > 0);

      if (softDegradeAt) {
        const remainingMs = softDegradeAt - Date.now();
        const searchPhase = remainingMs <= 0
          ? "degrade"
          : await resolveUnlessAborted(
              Promise.race([
                allSearchSettledPromise.then(() => "all" as const),
                softDegradeDelay("degrade" as const, remainingMs),
              ]),
              cancelSearchOnAbort ? signal : undefined,
            );

        if (searchPhase === "all") {
          await allSearchSettledPromise;
        } else {
          markDegraded("degrade_after_ms");
          if (!hasUsableSettledResult()) {
            await resolveUnlessAborted(
              new Promise<"usable" | "all">((resolve) => {
                const maybeResolve = () => {
                  if (hasUsableSettledResult()) {
                    resolve("usable");
                    return;
                  }
                  if (vectorTracker.settled && bm25Tracker.settled) {
                    resolve("all");
                  }
                };
                vectorSearchPromise.then(maybeResolve, maybeResolve);
                bm25SearchPromise.then(maybeResolve, maybeResolve);
                maybeResolve();
              }),
              cancelSearchOnAbort ? signal : undefined,
            );
          }
          if ((!vectorTracker.settled || !bm25Tracker.settled) && hasUsableSettledResult()) {
            markDegraded("partial_backend_result");
          } else {
            await allSearchSettledPromise;
          }
        }
      } else {
        await resolveUnlessAborted(
          allSearchSettledPromise,
          cancelSearchOnAbort ? signal : undefined,
        );
      }
      throwIfAborted(cancelSearchOnAbort ? signal : undefined);
      if (diagnostics?.latencyMs) diagnostics.latencyMs.parallelSearch = Date.now() - t1;

      const vectorResult_ = vectorTracker.settled;
      const bm25Result_ = bm25Tracker.settled;

      let vectorResults: Array<MemorySearchResult & { rank: number }>;
      let bm25Results: Array<MemorySearchResult & { rank: number }>;

      if (!vectorResult_) {
        vectorResults = [];
      } else if (vectorResult_.status === "rejected") {
        const error = attachFailureStage(vectorResult_.reason, "hybrid.vectorSearch");
        this.logger.warn(`[Retriever] vector search failed: ${error.message}`);
        vectorResults = [];
      } else {
        vectorResults = vectorResult_.value;
      }

      if (!bm25Result_) {
        bm25Results = [];
      } else if (bm25Result_.status === "rejected") {
        const error = attachFailureStage(bm25Result_.reason, "hybrid.bm25Search");
        this.logger.warn(`[Retriever] bm25 search failed: ${error.message}`);
        bm25Results = [];
      } else {
        bm25Results = bm25Result_.value;
      }

      // Check if BOTH backends failed (rejected), not just empty results
      // Empty result sets are valid; only throw when both promises reject
      const bothFailed =
        vectorResult_?.status === "rejected" && bm25Result_?.status === "rejected";
      const degraded =
        diagnostics?.degraded === true ||
        vectorResult_?.status === "rejected" ||
        bm25Result_?.status === "rejected";

      if (bothFailed) {
        const vectorError = vectorResult_?.reason?.message || "unknown";
        const bm25Error = bm25Result_?.reason?.message || "unknown";
        throw attachFailureStage(
          new Error(`both vector and BM25 search failed: ${vectorError}, ${bm25Error}`),
          "hybrid.parallelSearch",
        );
      }
      if (diagnostics) {
        diagnostics.vectorResultCount = vectorResults.length;
        diagnostics.bm25ResultCount = bm25Results.length;
      }
      if (trace) {
        const allSearchIds = [
          ...new Set([
            ...vectorResults.map((r) => r.entry.id),
            ...bm25Results.map((r) => r.entry.id),
          ]),
        ];
        const allScores = [
          ...vectorResults.map((r) => r.score),
          ...bm25Results.map((r) => r.score),
        ];
        trace.endStage(allSearchIds, allScores);
      }

      markStage("hybrid.fuseResults");
      if (trace) {
        const allInputIds = [
          ...new Set([
            ...vectorResults.map((r) => r.entry.id),
            ...bm25Results.map((r) => r.entry.id),
          ]),
        ];
        trace.startStage("rrf_fusion", allInputIds);
      }
      const t2 = Date.now();
      const fusedResults = await fuseResults(
        vectorResults,
        bm25Results,
        this.config,
        this.store as Parameters<typeof fuseResults>[3],
        this.logger,
        source === "auto-recall" ? signal : undefined,
      );
      if (diagnostics?.latencyMs) diagnostics.latencyMs.fuse = Date.now() - t2;
      trace?.endStage(fusedResults.map((r) => r.entry.id), fusedResults.map((r) => r.score));
      if (diagnostics) diagnostics.fusedResultCount = fusedResults.length;

      trace?.startStage("min_score_filter", fusedResults.map((r) => r.entry.id));
      const scoreFiltered = fusedResults.filter((r) => r.score >= this.config.minScore);
      trace?.endStage(scoreFiltered.map((r) => r.entry.id), scoreFiltered.map((r) => r.score));

      // Filter expired memories early — before rerank/scoring
      const filtered = scoreFiltered.filter((r) => {
        return !isMemoryExpired(r.entry._parsedMeta ?? parseSmartMetadata(r.entry.metadata, r.entry));
      });
      if (diagnostics) diagnostics.stageCounts.afterMinScore = filtered.length;

      const rerankInput =
        this.config.rerank !== "none" ? filtered.slice(0, limit * 2) : filtered;
      if (diagnostics) diagnostics.stageCounts.rerankInput = rerankInput.length;

      let reranked: RetrievalResult[];
      markStage("hybrid.rerank");
      if (this.config.rerank !== "none") {
        if (hasSoftDegraded() || diagnostics?.degraded === true) {
          markDegraded("skip_rerank_after_degrade");
          trace?.startStage("rerank", filtered.map((r) => r.entry.id));
          reranked = filtered;
          if (diagnostics?.latencyMs) diagnostics.latencyMs.rerank = 0;
          trace?.endStage(reranked.map((r) => r.entry.id), reranked.map((r) => r.score));
        } else if (!queryVector) {
          throw attachFailureStage(
            new Error("query embedding unavailable for rerank"),
            "hybrid.embedQuery",
          );
        } else {
          trace?.startStage("rerank", filtered.map((r) => r.entry.id));
          const t3 = Date.now();
          const rerankPromise = rerankResults(
            query,
            queryVector,
            rerankInput,
            this.config,
            async (ids: string[]) => this.store.hasIds?.(ids) ?? new Set<string>(),
            this.logger,
            signal,
          );
          if (softDegradeAt) {
            const remainingMs = softDegradeAt - Date.now();
            if (remainingMs <= 0) {
              markDegraded("skip_rerank_after_degrade");
              reranked = filtered;
            } else {
              const rerankOutcome = await resolveUnlessAborted(
                Promise.race([
                  rerankPromise.then((value) => ({ kind: "reranked" as const, value })),
                  softDegradeDelay({ kind: "degrade" as const }, remainingMs),
                ]),
                signal,
              );
              if (rerankOutcome.kind === "degrade") {
                markDegraded("skip_rerank_after_degrade");
                reranked = filtered;
              } else {
                reranked = rerankOutcome.value;
              }
            }
          } else {
            reranked = await rerankPromise;
          }
          if (diagnostics?.latencyMs) diagnostics.latencyMs.rerank = Date.now() - t3;
          trace?.endStage(reranked.map((r) => r.entry.id), reranked.map((r) => r.score));
        }
      } else {
        reranked = filtered;
      }
      if (diagnostics) diagnostics.stageCounts.afterRerank = reranked.length;

      markStage("hybrid.postProcess");
      const t4 = Date.now();
      const skipTimeDecay = !!(this.decayEngine || this.recencyEngine);
      const finalResults = await this.applyPostProcessingPipeline(reranked, limit, {
        skipTimeDecay,
        trace,
        diagnostics,
        preserveWhenHardFiltered: degraded,
      });
      if (diagnostics?.latencyMs) diagnostics.latencyMs.postProcess = Date.now() - t4;
      return finalResults;
    } catch (error) {
      if (diagnostics) {
        diagnostics.failureStage = extractFailureStage(error) ?? failureStage;
        if (signal?.aborted) {
          diagnostics.degraded = true;
          diagnostics.degradedReason = "hard_timeout";
        }
      }
      throw error;
    }
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
    overFetchMultiplier?: number,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      0.1,
      scopeFilter,
      { excludeInactive: true, overFetchMultiplier },
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    overFetchMultiplier?: number,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter, { excludeInactive: true, overFetchMultiplier });

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private buildBM25Query(
    query: string,
    source?: RetrievalContext["source"],
  ): string {
    if (!this.config.queryExpansion) return query;
    if (source !== "manual" && source !== "cli") return query;
    return expandQuery(query);
  }

  /**
   * Record access stats (access_count, last_accessed_at) and apply tier
   * promotion/demotion for a small number of top results.
   *
   * Note: this writes back to LanceDB via delete+readd; keep it bounded.
   */
  private async recordAccessAndMaybeTransition(results: RetrievalResult[]): Promise<void> {
    if (!this.decayEngine && !this.tierManager) return;

    const now = Date.now();
    const toUpdate = results.slice(0, 3);

    for (const r of toUpdate) {
      const { memory, meta: rawMeta } = getDecayableFromEntry(r.entry);
      const meta = JSON.parse(JSON.stringify(rawMeta)) as typeof rawMeta;

      // Update access stats in-memory first
      const nextAccess = memory.accessCount + 1;
      meta.access_count = nextAccess;
      meta.last_accessed_at = now;
      if (meta.created_at === undefined && meta.createdAt === undefined) {
        meta.created_at = memory.createdAt;
      }
      if (meta.tier === undefined) {
        meta.tier = memory.tier;
      }
      if (meta.confidence === undefined) {
        meta.confidence = memory.confidence;
      }

      const updatedMemory: DecayableMemory = {
        ...memory,
        accessCount: nextAccess,
        lastAccessedAt: now,
      };

      // Tier transition (optional)
      if (this.decayEngine && this.tierManager) {
        const ds = this.decayEngine.score(updatedMemory, now);
        const transition = this.tierManager.evaluate(updatedMemory, ds, now);
        if (transition) {
          meta.tier = transition.toTier;
        }
      }

      try {
        await this.store.update(r.entry.id, {
          metadata: JSON.stringify(meta),
        });
      } catch (err) {
        this.logger.debug(`[Retriever] tier metadata update failed for ${r.entry.id}: ${err}`);
      }
    }
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  getLastDiagnostics(): RetrievalDiagnostics | null {
    if (!this.lastDiagnostics) return null;
    const latencyMs = this.lastDiagnostics.latencyMs && Object.keys(this.lastDiagnostics.latencyMs).length > 0
      ? { ...this.lastDiagnostics.latencyMs }
      : undefined;
    return {
      ...this.lastDiagnostics,
      ...(this.lastDiagnostics.scopeFilter ? { scopeFilter: [...this.lastDiagnostics.scopeFilter] } : {}),
      ...(latencyMs ? { latencyMs } : {}),
      stageCounts: { ...this.lastDiagnostics.stageCounts },
      dropSummary: this.lastDiagnostics.dropSummary.map((drop) => ({
        ...drop,
      })),
    };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const _results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
  options?: RetrieverLifecycleOptions,
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  const retriever = new MemoryRetriever(
    store,
    embedder,
    fullConfig,
    options?.decayEngine ?? null,
    options?.logger ?? fallbackRetrieverLogger,
  );
  if (options?.recencyEngine) {
    retriever.setRecencyEngine(options.recencyEngine);
  }
  if (options?.tierManager) {
    retriever.setTierManager(options.tierManager);
  }
  return retriever;
}
