/**
 * Shared types, interfaces, and constants for the retrieval system.
 */

import type { MemorySearchResult } from "./store.js";
import type { Logger } from "./logger.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  /** Expand BM25 queries with high-signal synonyms for manual / CLI retrieval. */
  queryExpansion: boolean;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (required for cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (required for cross-encoder reranking) */
  rerankModel?: string;
  /** Reranker API endpoint (required for cross-encoder reranking). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score
   *  - "tei": Authorization: Bearer, string[] texts, top-level [{ index, score }] */
  rerankProvider?:
    | "jina"
    | "siliconflow"
    | "voyage"
    | "pinecone"
    | "dashscope"
    | "tei";
  /** Rerank API timeout in milliseconds (default: 5000). Increase for local/CPU-based rerank servers. */
  rerankTimeoutMs?: number;
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /** Access reinforcement factor for time decay half-life extension.
   *  Higher = stronger reinforcement. 0 to disable. (default: 0.5) */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from access reinforcement.
   *  Prevents frequently accessed memories from becoming immortal. (default: 3) */
  maxHalfLifeMultiplier: number;
  /** Tag prefixes for exact-match queries (default: ["proj", "env", "team", "scope"]).
   *  Queries containing these prefixes (e.g. "proj:AIF") will use BM25-only + mustContain
   *  to avoid semantic false positives from vector search. */
  tagPrefixes: string[];
}

export const fallbackRetrieverLogger: Pick<Logger, "debug" | "warn"> = {
  debug: (message, ...args) => console.debug(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
};

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands. */
  source?: "manual" | "auto-recall" | "cli";
  /** Optional AbortSignal. When aborted, in-flight embedding calls cancel and
   *  the method rejects due to abort (often with AbortError or the signal's
   *  abort reason) instead of holding the caller's session lock while the
   *  underlying HTTP request runs to completion. */
  signal?: AbortSignal;
  /** Optional per-call candidate pool override for latency-sensitive retrieval. */
  candidatePoolSize?: number;
  /** Optional per-call inactive-record over-fetch multiplier. */
  overFetchMultiplier?: number;
  /** Soft degradation threshold for auto-recall. Manual / CLI retrieval ignores it. */
  degradeAfterMs?: number;
  /** Hard caller deadline timestamp (epoch ms), used for diagnostics and deadline-aware fallbacks. */
  deadlineAt?: number;
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
  /**
   * Confidence score (0-1) indicating overall result quality.
   * Combines retrieval score, recency, access count, and decay signals.
   * Higher = more confident the result is relevant and current.
   */
  confidence?: number;
}

export interface RetrievalDiagnostics {
  source?: RetrievalContext["source"];
  mode: RetrievalConfig["mode"];
  originalQuery: string;
  bm25Query: string | null;
  queryExpanded: boolean;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  vectorResultCount: number;
  bm25ResultCount: number;
  fusedResultCount: number;
  finalResultCount: number;
  /** Millisecond durations for key retrieval stages. Undefined when not measured. */
  latencyMs?: {
    embedQuery?: number;
    vectorSearch?: number;
    bm25Search?: number;
    parallelSearch?: number;
    fuse?: number;
    rerank?: number;
    postProcess?: number;
  };
  currentStage?: NonNullable<RetrievalDiagnostics["failureStage"]>;
  currentStageStartedAt?: number;
  stageCounts: {
    afterMinScore: number;
    rerankInput: number;
    afterRerank: number;
    afterRecency: number;
    afterImportance: number;
    afterLengthNorm: number;
    afterTimeDecay: number;
    afterHardMinScore: number;
    afterNoiseFilter: number;
    afterDiversity: number;
  };
  dropSummary: Array<{
    stage:
      | "minScore"
      | "rerankWindow"
      | "rerank"
      | "recencyBoost"
      | "importanceWeight"
      | "lengthNorm"
      | "timeDecay"
      | "hardMinScore"
      | "noiseFilter"
      | "diversity"
      | "limit";
    before: number;
    after: number;
    dropped: number;
  }>;
  failureStage?:
    | "vector.embedQuery"
    | "vector.vectorSearch"
    | "vector.postProcess"
    | "hybrid.embedQuery"
    | "hybrid.vectorSearch"
    | "hybrid.bm25Search"
    | "hybrid.parallelSearch"
    | "hybrid.fuseResults"
    | "hybrid.rerank"
    | "hybrid.postProcess";
  degraded?: boolean;
  degradedReason?:
    | "degrade_after_ms"
    | "partial_backend_result"
    | "skip_rerank_after_degrade"
    | "hard_timeout";
  errorMessage?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  queryExpansion: true,
  minScore: 0.5,
  rerank: "cross-encoder",
  candidatePoolSize: 12,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.15,
  filterNoise: true,
  rerankProvider: "jina",
  rerankTimeoutMs: 5000,
  lengthNormAnchor: 500,
  hardMinScore: 0.55,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
  tagPrefixes: ["proj", "env", "team", "scope"],
};

// ============================================================================
// Internal Types
// ============================================================================

export type TaggedRetrievalError = Error & {
  retrievalFailureStage?: NonNullable<RetrievalDiagnostics["failureStage"]>;
};

export type BatchIdStore = {
  hasIds?: (ids: string[]) => Promise<Set<string>>;
};

// ============================================================================
// Lifecycle Options
// ============================================================================

import type { DecayEngine } from "./decay-engine.js";
import { RecencyEngine } from "./recency-engine.js";
import type { TierManager } from "./tier-manager.js";
import type { HybridNoiseDetector } from "./noise-detector.js";

export interface RetrieverLifecycleOptions {
  decayEngine?: DecayEngine;
  recencyEngine?: RecencyEngine;
  noiseDetector?: HybridNoiseDetector;
  tierManager?: TierManager;
  logger?: Pick<Logger, "debug" | "warn">;
}
