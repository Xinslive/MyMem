/**
 * Smart Memory Extractor — LLM-powered extraction pipeline
 * Replaces regex-triggered capture with intelligent 6-category extraction.
 *
 * Pipeline: conversation → LLM extract → candidates → dedup → persist
 *
 */

import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { LlmClient } from "./llm-client.js";
import {
  buildExtractionPrompt,
} from "./extraction-prompts.js";
import {
  AdmissionController,
  type AdmissionAuditRecord,
  type AdmissionControlConfig,
  type AdmissionRejectionAuditEntry,
} from "./admission-control.js";
import {
  type CandidateMemory,
  type ExtractionStats,
  ALWAYS_MERGE_CATEGORIES,
  MERGE_SUPPORTED_CATEGORIES,
  TEMPORAL_VERSIONED_CATEGORIES,
  normalizeCategory,
} from "./memory-categories.js";
import { isNoise } from "./noise-filter.js";
import type { NoisePrototypeBank } from "./noise-prototypes.js";
import {
  type WorkspaceBoundaryConfig,
  isUserMdExclusiveMemory,
} from "./workspace-boundary.js";
import { batchDedup } from "./batch-dedup.js";
import { stripEnvelopeMetadata } from "./envelope-stripping.js";
import {
  deduplicate,
  type DedupContext,
} from "./smart-extractor-dedup.js";
import {
  handleProfileMerge,
  handleMerge,
  handleSupersede,
  handleSupport,
  handleContextualize,
  handleContradict,
  storeCandidate,
  mapToStoreCategory,
  getDefaultImportance,
  type HandlerContext,
} from "./smart-extractor-handlers.js";

// Re-exports for backward compatibility
export { stripEnvelopeMetadata } from "./envelope-stripping.js";
export {
  type ExtractionRateLimiterOptions,
  type ExtractionRateLimiter,
  createExtractionRateLimiter,
} from "./extraction-rate-limiter.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_MEMORIES_PER_EXTRACTION = 5;

// ============================================================================
// Smart Extractor
// ============================================================================

export interface SmartExtractorConfig {
  /** User identifier for extraction prompt. */
  user?: string;
  /** Minimum conversation messages before extraction triggers. */
  extractMinMessages?: number;
  /** Maximum characters of conversation text to process. */
  extractMaxChars?: number;
  /** Default scope for new memories. */
  defaultScope?: string;
  /** Logger function. */
  log?: (msg: string) => void;
  /** Debug logger function. */
  debugLog?: (msg: string) => void;
  /** Optional embedding-based noise prototype bank for language-agnostic noise filtering. */
  noiseBank?: NoisePrototypeBank;
  /** Facts reserved for workspace-managed USER.md should never enter LanceDB. */
  workspaceBoundary?: WorkspaceBoundaryConfig;
  /** Optional admission-control governance layer before downstream dedup/persistence. */
  admissionControl?: AdmissionControlConfig;
  /** Optional sink for durable reject-audit logging. */
  onAdmissionRejected?: (entry: AdmissionRejectionAuditEntry) => Promise<void> | void;
  /** Optional callback when a candidate passes admission control. */
  onAdmissionAdmitted?: (category: string) => void;
  /** Optional sink for extraction telemetry persistence. */
  onExtractionComplete?: (payload: {
    sessionKey: string;
    scope: string;
    stats: ExtractionStats;
  }) => Promise<void> | void;
}

export interface ExtractPersistOptions {
  /** Target scope for newly created memories. */
  scope?: string;
  /**
   * Optional store-layer scope filter override used for dedup/merge reads.
   * - omit the field to default reads to `[scope ?? defaultScope]`
   * - set `undefined` explicitly to preserve trusted full-bypass callers
   * - pass `[]` to force deny-all reads (match nothing)
   * - pass a non-empty array to restrict reads to those scopes
   */
  scopeFilter?: string[];
}

export class SmartExtractor {
  private log: (msg: string) => void;
  private debugLog: (msg: string) => void;
  private admissionController: AdmissionController | null;
  private persistAdmissionAudit: boolean;
  private onAdmissionRejected?: (entry: AdmissionRejectionAuditEntry) => Promise<void> | void;
  private onAdmissionAdmitted?: (category: string) => void;
  private onExtractionComplete?: (payload: {
    sessionKey: string;
    scope: string;
    stats: ExtractionStats;
  }) => Promise<void> | void;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private llm: LlmClient,
    private config: SmartExtractorConfig = {},
  ) {
    this.log = config.log ?? (() => {});
    this.debugLog = config.debugLog ?? (() => { });
    this.persistAdmissionAudit =
      config.admissionControl?.enabled === true &&
      config.admissionControl.auditMetadata !== false;
    this.onAdmissionRejected = config.onAdmissionRejected;
    this.onAdmissionAdmitted = config.onAdmissionAdmitted;
    this.onExtractionComplete = config.onExtractionComplete;
    this.admissionController =
      config.admissionControl?.enabled === true
        ? new AdmissionController(
            this.store,
            this.llm,
            config.admissionControl,
            this.debugLog,
          )
        : null;
  }

  /** Exposes the AdmissionController for the feedback loop's prior adaptation. */
  getAdmissionController(): AdmissionController | null {
    return this.admissionController;
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  /**
   * Extract memories from a conversation text and persist them.
   * Returns extraction statistics.
   */
  async extractAndPersist(
    conversationText: string,
    sessionKey: string = "unknown",
    options: ExtractPersistOptions = {},
  ): Promise<ExtractionStats> {
    const startedAt = Date.now();
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 };
    let candidateCount = 0;
    let cappedCandidateCount = 0;
    let processableCandidateCount = 0;
    let duplicateSkipped = 0;
    let batchDedupMs = 0;
    let batchEmbedMs = 0;
    let processMs = 0;
    let flushMs = 0;
    const attachTelemetry = () => {
      stats.telemetry = {
        totalMs: Date.now() - startedAt,
        candidateCount,
        cappedCandidateCount,
        processableCandidateCount,
        duplicateSkipped,
        batchDedupMs,
        batchEmbedMs,
        processMs,
        flushMs,
      };
    };
    const targetScope = options.scope ?? this.config.defaultScope ?? "global";
    // Distinguish "no override supplied" from explicit bypass/override values.
    // - omitted `scopeFilter` => default to `[targetScope]`
    // - explicit `undefined` => preserve full-bypass semantics for trusted callers
    // - explicit `[]` or non-empty array => pass through unchanged
    const hasExplicitScopeFilter = "scopeFilter" in options;
    const scopeFilter = hasExplicitScopeFilter
      ? options.scopeFilter
      : [targetScope];

    // Step 1: LLM extraction
    const candidates = await this.extractCandidates(conversationText);
    candidateCount = candidates.length;

    if (candidates.length === 0) {
      this.log("mymem: smart-extractor: no memories extracted");
      // LLM returned zero candidates → strongest noise signal → feedback to noise bank
      this.learnAsNoise(conversationText);
      attachTelemetry();
      if (this.onExtractionComplete) {
        await this.onExtractionComplete({
          sessionKey,
          scope: targetScope,
          stats,
        });
      }
      return stats;
    }

    this.log(
      `mymem: smart-extractor: extracted ${candidates.length} candidate(s)`,
    );

    // Step 1b: Apply storage-boundary filters before any embedding work.
    // USER.md-exclusive memories should not consume batch-dedup slots or cause
    // non-boundary candidates to be dropped as near-duplicates.
    const capped = candidates.slice(0, MAX_MEMORIES_PER_EXTRACTION);
    cappedCandidateCount = capped.length;
    const boundaryEligibleCandidates: CandidateMemory[] = [];
    for (const c of capped) {
      if (
        isUserMdExclusiveMemory(
          {
            memoryCategory: c.category,
            abstract: c.abstract,
            content: c.content,
          },
          this.config.workspaceBoundary,
        )
      ) {
        stats.skipped += 1;
        stats.boundarySkipped = (stats.boundarySkipped ?? 0) + 1;
        this.log(
          `mymem: smart-extractor: skipped USER.md-exclusive [${c.category}] ${c.abstract.slice(0, 60)}`,
        );
        continue;
      }
      boundaryEligibleCandidates.push(c);
    }

    // Step 1c: Batch-internal dedup — embed candidate abstracts and remove
    // near-duplicates before expensive per-candidate LLM dedup calls.
    let survivingCandidates = boundaryEligibleCandidates;
    const batchDedupStartedAt = Date.now();
    if (boundaryEligibleCandidates.length > 1) {
      try {
        const abstracts = boundaryEligibleCandidates.map((c) => c.abstract);
        const vectors = await this.embedder.embedBatch(abstracts);
        const safeVectors = vectors.map((v) => v || []);
        const dedupResult = batchDedup(abstracts, safeVectors);
        if (dedupResult.duplicateIndices.length > 0) {
          survivingCandidates = dedupResult.survivingIndices.map((i) => boundaryEligibleCandidates[i]);
          duplicateSkipped = dedupResult.duplicateIndices.length;
          stats.skipped += dedupResult.duplicateIndices.length;
          this.log(
            `mymem: smart-extractor: batchDedup dropped ${dedupResult.duplicateIndices.length} near-duplicate(s), ${survivingCandidates.length} survivor(s)`,
          );
        }
      } catch (err) {
        this.log(
          `mymem: smart-extractor: batchDedup failed, proceeding without batch dedup: ${String(err)}`,
        );
      } finally {
        batchDedupMs = Date.now() - batchDedupStartedAt;
      }
    }

    // Step 2: Process each surviving candidate through dedup pipeline.
    const processableCandidates = survivingCandidates.map((candidate, index) => ({ index, candidate }));
    processableCandidateCount = processableCandidates.length;

    // Pre-compute vectors for processable non-profile candidates in a single batch API call
    // to reduce embedding round-trips from N to 1.
    const precomputedVectors = new Map<number, number[]>();
    const nonProfileToEmbed: { index: number; text: string }[] = [];
    for (const { index, candidate } of processableCandidates) {
      if (!ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
        nonProfileToEmbed.push({ index, text: `${candidate.abstract} ${candidate.content}` });
      }
    }
    if (nonProfileToEmbed.length > 0) {
      const batchEmbedStartedAt = Date.now();
      try {
        const batchTexts = nonProfileToEmbed.map((e) => e.text);
        const batchVectors = await this.embedder.embedBatch(batchTexts);
        for (let j = 0; j < nonProfileToEmbed.length; j++) {
          const vec = batchVectors[j];
          if (vec && vec.length > 0) {
            precomputedVectors.set(nonProfileToEmbed[j].index, vec);
          }
        }
      } catch (err) {
        this.log(
          `mymem: smart-extractor: batch pre-embed failed, will embed individually: ${String(err)}`,
        );
      } finally {
        batchEmbedMs = Date.now() - batchEmbedStartedAt;
      }
    }

    const processStartedAt = Date.now();
    let flushStartedAt = 0;
    const processCandidates = async () => {
      for (const { index, candidate } of processableCandidates) {
        try {
          await this.processCandidate(
            candidate,
            conversationText,
            sessionKey,
            stats,
            targetScope,
            scopeFilter,
            precomputedVectors.get(index),
          );
        } catch (err) {
          this.log(
            `mymem: smart-extractor: failed to process candidate [${candidate.category}]: ${String(err)}`,
          );
        }
      }
    };

    const runBatch = (this.store as unknown as {
      runBatch?: <T>(fn: () => Promise<T> | T, options?: { onBeforeFlush?: () => void }) => Promise<{ result: T; written: unknown[] }>;
    }).runBatch;

    if (typeof runBatch === "function") {
      await runBatch.call(this.store, processCandidates, {
        onBeforeFlush: () => {
          processMs = Date.now() - processStartedAt;
          flushStartedAt = Date.now();
        },
      });
    } else {
      this.store.startBatch();
      try {
        await processCandidates();
        processMs = Date.now() - processStartedAt;
        flushStartedAt = Date.now();
        await this.store.flushBatch();
      } catch (err) {
        const cancelBatch = (this.store as unknown as { cancelBatch?: () => unknown }).cancelBatch;
        if (typeof cancelBatch === "function") cancelBatch.call(this.store);
        throw err;
      }
    }
    if (processMs === 0) {
      processMs = Date.now() - processStartedAt;
    }
    flushMs = flushStartedAt > 0 ? Date.now() - flushStartedAt : 0;

    attachTelemetry();
    const telemetry = stats.telemetry!;
    this.debugLog(
      `mymem: smart-extractor telemetry total=${telemetry.totalMs}ms candidates=${candidateCount} processable=${processableCandidateCount} created=${stats.created} merged=${stats.merged} skipped=${stats.skipped} rejected=${stats.rejected ?? 0}`,
    );
    if (this.onExtractionComplete) {
      await this.onExtractionComplete({
        sessionKey,
        scope: targetScope,
        stats,
      });
    }
    return stats;
  }

  // --------------------------------------------------------------------------
  // Embedding Noise Pre-Filter
  // --------------------------------------------------------------------------

  /**
   * Filter out texts that match noise prototypes by embedding similarity.
   * Long texts (>300 chars) are passed through without checking.
   * Only active when noiseBank is configured and initialized.
   *
   * Uses batch embedding to reduce API round-trips from N to 1.
   */
  async filterNoiseByEmbedding(texts: string[]): Promise<string[]> {
    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) return texts;

    // Partition: short/long texts bypass noise check; mid-length need embedding
    const SHORT_THRESHOLD = 8;
    const LONG_THRESHOLD = 300;
    const bypassFlags: boolean[] = texts.map(
      (t) => t.length <= SHORT_THRESHOLD || t.length > LONG_THRESHOLD,
    );

    const needsEmbedIndices: number[] = [];
    const needsEmbedTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (!bypassFlags[i]) {
        needsEmbedIndices.push(i);
        needsEmbedTexts.push(texts[i]);
      }
    }

    // Batch embed all mid-length texts in a single API call
    let vectors: number[][] = [];
    if (needsEmbedTexts.length > 0) {
      try {
        vectors = await this.embedder.embedBatch(needsEmbedTexts);
      } catch (err) {
        this.debugLog?.(`smart-extractor: batch embed failed: ${err}, passing through texts unchanged`);
        // Batch failed — pass all through
        return texts.slice();
      }
    }

    const result: string[] = new Array(texts.length);
    // First, fill in bypass texts (always kept)
    for (let i = 0; i < texts.length; i++) {
      if (bypassFlags[i]) {
        result[i] = texts[i];
      }
    }

    // Then, check noise for embedded texts
    for (let j = 0; j < needsEmbedIndices.length; j++) {
      const idx = needsEmbedIndices[j];
      const vec = vectors[j];
      if (!vec || vec.length === 0) {
        result[idx] = texts[idx];
        continue;
      }
      if (noiseBank.isNoise(vec)) {
        this.debugLog(
          `mymem: smart-extractor: embedding noise filtered: ${texts[idx].slice(0, 80)}`,
        );
        // Leave result[idx] as undefined — will be compacted below
      } else {
        result[idx] = texts[idx];
      }
    }

    // Compact: remove undefined slots (filtered-out entries).
    // Use explicit undefined check rather than filter(Boolean) to preserve
    // empty strings that were legitimately in bypass slots.
    return result.filter((x): x is string => x !== undefined);
  }

  /**
   * Feed back conversation text to the noise prototype bank.
   * Called when LLM extraction returns zero candidates (strongest noise signal).
   */
  private async learnAsNoise(conversationText: string): Promise<void> {
    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) return;

    try {
      const tail = conversationText.slice(-300);
      const vec = await this.embedder.embed(tail);
      if (vec && vec.length > 0) {
        noiseBank.learn(vec);
        this.debugLog("mymem: smart-extractor: learned noise from zero-extraction");
      }
    } catch (err) {
      this.debugLog?.(`smart-extractor: failed to learn noise prototype: ${err}`);
    }
  }

  // --------------------------------------------------------------------------
  // Step 1: LLM Extraction
  // --------------------------------------------------------------------------

  /**
   * Call LLM to extract candidate memories from conversation text.
   */
  private async extractCandidates(
    conversationText: string,
  ): Promise<CandidateMemory[]> {
    const maxChars = this.config.extractMaxChars ?? 8000;
    const truncated =
      conversationText.length > maxChars
        ? conversationText.slice(-maxChars)
        : conversationText;

    // Strip platform envelope metadata injected by OpenClaw channels
    // (e.g. "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_...")
    // These pollute extraction if treated as conversation content.
    const cleaned = stripEnvelopeMetadata(truncated);

    const user = this.config.user ?? "User";
    const prompt = buildExtractionPrompt(cleaned, user);

    const result = await this.llm.completeJson<{
      memories: Array<{
        category: string;
        abstract: string;
        overview: string;
        content: string;
      }>;
    }>(prompt, "extract-candidates");

    if (!result) {
      this.debugLog(
        "mymem: smart-extractor: extract-candidates returned null",
      );
      return [];
    }
    if (!result.memories || !Array.isArray(result.memories)) {
      this.debugLog(
        `mymem: smart-extractor: extract-candidates returned unexpected shape keys=${Object.keys(result).join(",") || "(none)"}`,
      );
      return [];
    }

    this.debugLog(
      `mymem: smart-extractor: extract-candidates raw memories=${result.memories.length}`,
    );

    // Validate and normalize candidates
    const candidates: CandidateMemory[] = [];
    let invalidCategoryCount = 0;
    let shortAbstractCount = 0;
    let noiseAbstractCount = 0;
    for (const raw of result.memories) {
      if (!raw || typeof raw !== "object") {
        invalidCategoryCount++;
        this.debugLog(
          `mymem: smart-extractor: dropping null/invalid candidate entry`,
        );
        continue;
      }
      const category = normalizeCategory(raw.category ?? "");
      if (!category) {
        invalidCategoryCount++;
        this.debugLog(
          `mymem: smart-extractor: dropping candidate due to invalid category rawCategory=${JSON.stringify(raw.category ?? "")} abstract=${JSON.stringify((raw.abstract ?? "").trim().slice(0, 120))}`,
        );
        continue;
      }

      const abstract = (raw.abstract ?? "").trim();
      const overview = (raw.overview ?? "").trim();
      const content = (raw.content ?? "").trim();

      // Skip empty or noise
      if (!abstract || abstract.length < 5) {
        shortAbstractCount++;
        this.debugLog(
          `mymem: smart-extractor: dropping candidate due to short abstract category=${category} abstract=${JSON.stringify(abstract)}`,
        );
        continue;
      }
      if (isNoise(abstract)) {
        noiseAbstractCount++;
        this.debugLog(
          `mymem: smart-extractor: dropping candidate due to noise abstract category=${category} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      candidates.push({ category, abstract, overview, content });
    }

    this.debugLog(
      `mymem: smart-extractor: validation summary accepted=${candidates.length}, invalidCategory=${invalidCategoryCount}, shortAbstract=${shortAbstractCount}, noiseAbstract=${noiseAbstractCount}`,
    );

    return candidates;
  }

  // --------------------------------------------------------------------------
  // Step 2: Dedup + Persist
  // --------------------------------------------------------------------------

  /**
   * Process a single candidate memory: dedup → merge/create → store
   *
   * @param precomputedVector - Optional pre-embedded vector for the candidate.
   *   When provided (from batch pre-embedding), skips the per-candidate embed
   *   call to reduce API round-trips.
   */
  private async processCandidate(
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    stats: ExtractionStats,
    targetScope: string,
    scopeFilter?: string[],
    precomputedVector?: number[],
  ): Promise<void> {
    // Build handler context for extracted functions
    const handlerCtx: HandlerContext = {
      store: this.store,
      embedder: this.embedder,
      llm: this.llm,
      log: { warn: (...args: unknown[]) => this.log(String(args[0])), info: (...args: unknown[]) => this.log(String(args[0])) },
      admissionController: this.admissionController,
      persistAdmissionAudit: this.persistAdmissionAudit,
      mapToStoreCategory,
      getDefaultImportance,
      recordRejectedAdmission: (candidate, conversationText, sessionKey, targetScope, scopeFilter, audit) =>
        this.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter, audit),
    };

    // Profile always merges (skip dedup — admission control still applies)
    if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
      const profileResult = await handleProfileMerge(
        handlerCtx,
        candidate,
        conversationText,
        sessionKey,
        targetScope,
        scopeFilter,
      );
      if (profileResult === "rejected") {
        stats.rejected = (stats.rejected ?? 0) + 1;
      } else if (profileResult === "created") {
        stats.created++;
      } else {
        stats.merged++;
      }
      return;
    }

    // Use pre-computed vector if available (batch embed optimization),
    // otherwise fall back to per-candidate embed call.
    const vector = precomputedVector ?? await this.embedder.embed(`${candidate.abstract} ${candidate.content}`);
    if (!vector || vector.length === 0) {
      this.log("mymem: smart-extractor: embedding failed, storing as-is");
      await storeCandidate(handlerCtx, candidate, vector || [], sessionKey, targetScope);
      stats.created++;
      return;
    }

    // Admission control gate (before dedup)
    const admission = this.admissionController
      ? await this.admissionController.evaluate({
          candidate,
          candidateVector: vector,
          conversationText,
          scopeFilter: scopeFilter ?? [targetScope],
        })
      : undefined;

    if (admission?.decision === "reject") {
      stats.rejected = (stats.rejected ?? 0) + 1;
      this.log(
        `mymem: smart-extractor: admission rejected [${candidate.category}] ${candidate.abstract.slice(0, 60)} — ${admission.audit.reason}`,
      );
      await this.recordRejectedAdmission(
        candidate,
        conversationText,
        sessionKey,
        targetScope,
        scopeFilter ?? [targetScope],
        admission.audit as AdmissionAuditRecord & { decision: "reject" },
      );
      return;
    }

    // Record admitted for feedback loop prior adaptation
    if (admission?.decision === "pass_to_dedup") {
      this.onAdmissionAdmitted?.(candidate.category);
    }

    // Dedup pipeline
    const dedupCtx: DedupContext = {
      store: this.store,
      llm: this.llm,
      log: { warn: (...args: unknown[]) => this.log(String(args[0])) },
    };
    const dedupResult = await deduplicate(dedupCtx, candidate, vector, scopeFilter);

    switch (dedupResult.decision) {
      case "create":
        await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
        stats.created++;
        break;

      case "merge":
        if (
          dedupResult.matchId &&
          MERGE_SUPPORTED_CATEGORIES.has(candidate.category)
        ) {
          await handleMerge(
            handlerCtx,
            candidate,
            dedupResult.matchId,
            targetScope,
            scopeFilter ?? [targetScope],
            dedupResult.contextLabel,
            admission?.audit,
          );
          stats.merged++;
        } else {
          // Category doesn't support merge → create instead
          await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
          stats.created++;
        }
        break;

      case "skip":
        this.log(
          `mymem: smart-extractor: skipped [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
        );
        stats.skipped++;
        break;

      case "supersede":
        if (
          dedupResult.matchId &&
          TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category)
        ) {
          await handleSupersede(
            handlerCtx,
            candidate,
            vector,
            dedupResult.matchId,
            sessionKey,
            targetScope,
            scopeFilter ?? [targetScope],
            admission?.audit,
          );
          stats.created++;
          stats.superseded = (stats.superseded ?? 0) + 1;
        } else {
          await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
          stats.created++;
        }
        break;

      case "support":
        if (dedupResult.matchId) {
          await handleSupport(handlerCtx, dedupResult.matchId, { session: sessionKey, timestamp: Date.now() }, dedupResult.reason, dedupResult.contextLabel, scopeFilter, admission?.audit);
          stats.supported = (stats.supported ?? 0) + 1;
        } else {
          await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
          stats.created++;
        }
        break;

      case "contextualize":
        if (dedupResult.matchId) {
          await handleContextualize(handlerCtx, candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, admission?.audit);
          stats.created++;
        } else {
          await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
          stats.created++;
        }
        break;

      case "contradict":
        if (dedupResult.matchId) {
          if (
            TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category) &&
            dedupResult.contextLabel === "general"
          ) {
            await handleSupersede(
              handlerCtx,
              candidate,
              vector,
              dedupResult.matchId,
              sessionKey,
              targetScope,
              scopeFilter ?? [targetScope],
              admission?.audit,
            );
            stats.created++;
            stats.superseded = (stats.superseded ?? 0) + 1;
          } else {
            await handleContradict(handlerCtx, candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, admission?.audit);
            stats.created++;
          }
        } else {
          await storeCandidate(handlerCtx, candidate, vector, sessionKey, targetScope, admission?.audit);
          stats.created++;
        }
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Admission Control Helpers
  // --------------------------------------------------------------------------

  /**
   * Record a rejected admission to the durable audit log.
   */
  private async recordRejectedAdmission(
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
    audit: AdmissionAuditRecord & { decision: "reject" },
  ): Promise<void> {
    if (!this.onAdmissionRejected) {
      return;
    }
    try {
      await this.onAdmissionRejected({
        version: "amac-v1",
        rejected_at: Date.now(),
        session_key: sessionKey,
        target_scope: targetScope,
        scope_filter: scopeFilter,
        candidate,
        audit,
        conversation_excerpt: conversationText.slice(-1200),
      });
    } catch (err) {
      this.log(
        `mymem: smart-extractor: rejected admission audit write failed: ${String(err)}`,
      );
    }
  }
}
