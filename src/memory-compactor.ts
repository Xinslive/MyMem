/**
 * Memory Compactor — Progressive Summarization
 *
 * Identifies clusters of semantically similar memories older than a configured
 * age threshold and merges each cluster into a single, higher-quality entry.
 *
 * Implements the "progressive summarization" pattern: memories get more refined
 * over time as related fragments are consolidated, reducing noise and improving
 * retrieval quality without requiring an external LLM call.
 *
 * Algorithm:
 *   1. Load memories older than `minAgeDays` (with vectors).
 *   2. Build similarity clusters using greedy cosine-similarity expansion.
 *   3. For each cluster >= `minClusterSize`, merge into one entry:
 *        - text:       deduplicated lines joined with newlines
 *        - importance: max of cluster members (never downgrade)
 *        - category:   plurality vote
 *        - scope:      shared scope (all members must share one)
 *        - metadata:   marked { compacted: true, sourceCount: N }
 *        - lifecycle:  sets initial accessCount=1, lastAccessedAt=now
 *   4. Delete source entries, store merged entry.
 *   5. Record access via AccessTracker to register new entry for future tracking.
 */

import type { MemoryEntry } from "./store.js";
import type { LlmClient } from "./llm-client.js";
import { buildSmartMetadata, reverseMapLegacyCategory, stringifySmartMetadata } from "./smart-metadata.js";
import type { MemoryCategory } from "./memory-categories.js";

// ============================================================================
// Types
// ============================================================================

export interface CompactionConfig {
  /** Enable automatic compaction. Default: false */
  enabled: boolean;
  /** Only compact memories at least this many days old. Default: 7 */
  minAgeDays: number;
  /** Cosine similarity threshold for clustering [0, 1]. Default: 0.88 */
  similarityThreshold: number;
  /** Minimum number of memories in a cluster to trigger merge. Default: 2 */
  minClusterSize: number;
  /** Maximum memories to scan per compaction run. Default: 200 */
  maxMemoriesToScan: number;
  /** Report plan without writing changes. Default: false */
  dryRun: boolean;
  /** Run at most once per N hours (gateway_start guard). Default: 6 */
  cooldownHours: number;
  /** Merge strategy. Default: "llm" */
  mergeMode?: "llm" | "deterministic";
  /** Delete source memories after creating the canonical memory. Default: true */
  deleteSourceMemories?: boolean;
  /** Maximum clusters refined with LLM per run. Default: 10 */
  maxLlmClustersPerRun?: number;
}

export interface CompactionEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryEntry["category"];
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
}

export interface ClusterPlan {
  /** Indices into the input entries array */
  memberIndices: number[];
  /** Proposed merged entry (without id/vector — computed by caller) */
  merged: {
    text: string;
    importance: number;
    category: MemoryEntry["category"];
    scope: string;
    metadata: string;
  };
}

export interface CompactionResult {
  /** Memories scanned (limited by maxMemoriesToScan) */
  scanned: number;
  /** Clusters found with >= minClusterSize members */
  clustersFound: number;
  /** Source memories deleted (0 when dryRun) */
  memoriesDeleted: number;
  /** Merged memories created (0 when dryRun) */
  memoriesCreated: number;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Clusters successfully refined by LLM */
  llmRefined: number;
  /** Clusters merged with deterministic fallback */
  fallbackMerged: number;
  /** Clusters that failed and were skipped */
  failedClusters: number;
}

interface RefinedMemory {
  abstract: string;
  overview: string;
  content: string;
  category: MemoryEntry["category"];
  memoryCategory: MemoryCategory;
  importance: number;
  reason: string;
}

// ============================================================================
// Math helpers
// ============================================================================

/** Dot product of two equal-length vectors. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2 norm of a vector. */
function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

/**
 * Cosine similarity in [0, 1].
 * Returns 0 if either vector has zero norm (avoids NaN).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot(a, b) / (na * nb)));
}

function normalizeScope(scope: string | null | undefined): string {
  return scope || "global";
}

function mapSmartCategoryToStoreCategory(category: MemoryCategory): MemoryEntry["category"] {
  switch (category) {
    case "profile":
    case "cases":
      return "fact";
    case "preferences":
      return "preference";
    case "entities":
      return "entity";
    case "events":
      return "decision";
    case "patterns":
      return "other";
  }
}

function normalizeRefinedCategory(
  rawCategory: unknown,
  fallback: ClusterPlan["merged"],
  text: string,
): { category: MemoryEntry["category"]; memoryCategory: MemoryCategory } {
  const raw = typeof rawCategory === "string" ? rawCategory.trim().toLowerCase() : "";
  const smartAliases: Record<string, MemoryCategory> = {
    profile: "profile",
    preference: "preferences",
    preferences: "preferences",
    entity: "entities",
    entities: "entities",
    event: "events",
    events: "events",
    decision: "events",
    case: "cases",
    cases: "cases",
    pattern: "patterns",
    patterns: "patterns",
    other: "patterns",
  };

  const smartCategory = smartAliases[raw];
  if (smartCategory) {
    return {
      category: mapSmartCategoryToStoreCategory(smartCategory),
      memoryCategory: smartCategory,
    };
  }

  if (raw === "fact") {
    return {
      category: "fact",
      memoryCategory: reverseMapLegacyCategory("fact", text),
    };
  }

  return {
    category: fallback.category,
    memoryCategory: reverseMapLegacyCategory(fallback.category, text),
  };
}

// ============================================================================
// Cluster building
// ============================================================================

/**
 * Greedy cluster expansion.
 *
 * Sort entries by importance DESC so the most valuable memory seeds each
 * cluster. Expand each seed by collecting every unassigned entry in the same
 * scope whose cosine similarity with the seed is >= threshold.
 *
 * Returns an array of index-arrays (each inner array = one cluster).
 * Only clusters with >= minClusterSize entries are returned.
 */
export function buildClusters(
  entries: CompactionEntry[],
  threshold: number,
  minClusterSize: number,
): ClusterPlan[] {
  if (entries.length < minClusterSize) return [];

  // Sort indices by importance desc (highest importance seeds first)
  const order = entries
    .map((_, i) => i)
    .sort((a, b) => entries[b].importance - entries[a].importance);

  const assigned = new Uint8Array(entries.length); // 0 = unassigned
  const plans: ClusterPlan[] = [];

  for (const seedIdx of order) {
    if (assigned[seedIdx]) continue;

    const cluster: number[] = [seedIdx];
    assigned[seedIdx] = 1;

    const seedVec = entries[seedIdx].vector;
    if (seedVec.length === 0) continue; // skip entries without vectors
    const seedScope = normalizeScope(entries[seedIdx].scope);

    for (let j = 0; j < entries.length; j++) {
      if (assigned[j]) continue;
      if (normalizeScope(entries[j].scope) !== seedScope) continue;
      const jVec = entries[j].vector;
      if (jVec.length === 0) continue;
      if (cosineSimilarity(seedVec, jVec) >= threshold) {
        cluster.push(j);
        assigned[j] = 1;
      }
    }

    if (cluster.length >= minClusterSize) {
      const members = cluster.map((i) => entries[i]);
      plans.push({
        memberIndices: cluster,
        merged: buildMergedEntry(members),
      });
    }
  }

  return plans;
}

// ============================================================================
// Merge strategy
// ============================================================================

/**
 * Merge a cluster of entries into a single proposed entry.
 *
 * Text strategy: deduplicate lines across all member texts, join with newline.
 * This preserves all unique information while removing redundancy.
 *
 * Importance: max across cluster (never downgrade).
 * Category: plurality vote; ties broken by member with highest importance.
 * Scope: all members must share a scope (validated upstream).
 */
export function buildMergedEntry(
  members: CompactionEntry[],
): ClusterPlan["merged"] {
  // --- text: deduplicate lines ---
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of members) {
    for (const line of m.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        lines.push(trimmed);
      }
    }
  }
  const text = lines.join("\n");

  // --- importance: max ---
  const importance = Math.min(
    1.0,
    Math.max(...members.map((m) => m.importance)),
  );

  // --- category: plurality vote ---
  const counts = new Map<string, number>();
  for (const m of members) {
    counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  }
  let category: MemoryEntry["category"] = "other";
  let best = 0;
  for (const [cat, count] of counts) {
    if (count > best) {
      best = count;
      category = cat as MemoryEntry["category"];
    }
  }

  // --- scope: use the first (all should match) ---
  const scope = normalizeScope(members[0].scope);

  // --- metadata ---
  const metadata = JSON.stringify({
    compacted: true,
    sourceCount: members.length,
    compactedAt: Date.now(),
    memory_category: reverseMapLegacyCategory(category, text),
  });

  return { text, importance, category, scope, metadata };
}

function normalizeMergeMode(value: CompactionConfig["mergeMode"]): "llm" | "deterministic" {
  return value === "deterministic" ? "deterministic" : "llm";
}

function normalizeDeleteSourceMemories(value: CompactionConfig["deleteSourceMemories"]): boolean {
  return value !== false;
}

function normalizeMaxLlmClustersPerRun(value: CompactionConfig["maxLlmClustersPerRun"]): number {
  return Math.max(0, Math.floor(value ?? 10));
}

function normalizeRefinedMemory(value: unknown, fallback: ClusterPlan["merged"]): RefinedMemory | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const abstract = typeof raw.abstract === "string" ? raw.abstract.trim() : "";
  const overview = typeof raw.overview === "string" ? raw.overview.trim() : "";
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!abstract || !content) return null;

  const { category, memoryCategory } = normalizeRefinedCategory(raw.category, fallback, content);
  const importance = typeof raw.importance === "number"
    ? Math.min(1, Math.max(0, raw.importance))
    : fallback.importance;

  return {
    abstract,
    overview: overview || `- ${abstract}`,
    content,
    category,
    memoryCategory,
    importance,
    reason: reason || "llm_refined_compaction",
  };
}

function buildRefinementPrompt(members: CompactionEntry[]): string {
  const memoryLines = members.map((member, index) => {
    return [
      `Memory ${index + 1}:`,
      `id: ${member.id}`,
      `category: ${member.category}`,
      `importance: ${member.importance}`,
      `text: ${member.text}`,
    ].join("\n");
  }).join("\n\n");

  return [
    "You refine duplicate or near-duplicate long-term memories into one canonical memory.",
    "Preserve durable user-relevant facts, preferences, decisions, and patterns. Remove repetition, obsolete wording, and low-signal noise.",
    "Return only JSON with keys: abstract, overview, content, category, importance, reason.",
    "category must be one of the smart memory categories: profile, preferences, entities, events, cases, patterns. importance must be a number from 0 to 1.",
    "abstract should be one concise sentence. overview should be a short bullet-style summary. content should be the canonical memory text.",
    "",
    memoryLines,
  ].join("\n");
}

async function refineClusterWithLlm(
  llm: LlmClient | undefined,
  members: CompactionEntry[],
  fallback: ClusterPlan["merged"],
): Promise<RefinedMemory | null> {
  if (!llm) return null;
  const response = await llm.completeJson<unknown>(
    buildRefinementPrompt(members),
    "memory-compaction-refine",
  );
  return normalizeRefinedMemory(response, fallback);
}

// ============================================================================
// Minimal store interface (duck-typed so no circular import)
// ============================================================================

export interface CompactorStore {
  fetchForCompaction(
    maxTimestamp: number,
    scopeFilter?: string[],
    limit?: number,
  ): Promise<CompactionEntry[]>;
  store(entry: {
    text: string;
    vector: number[];
    importance: number;
    category: MemoryEntry["category"];
    scope: string;
    metadata?: string;
  }): Promise<MemoryEntry>;
  delete(id: string, scopeFilter?: string[]): Promise<boolean>;
}

export interface CompactorEmbedder {
  embedPassage(text: string): Promise<number[]>;
}

export interface CompactorLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Lifecycle dependencies for post-compaction entry initialization.
 * These ensure merged entries are properly tracked for:
 * - Access statistics (accessCount, lastAccessedAt)
 * - Tier evaluation (core/working/peripheral)
 * - Decay scoring (half-life extension)
 */
export interface CompactorLifecycle {
  /**
   * Record access for newly created entries.
   * This sets accessCount=1 and lastAccessedAt=now, breaking the
   * accessCount=0 dead-lock that would prevent tier promotion.
   */
  recordAccess?(ids: readonly string[]): void;
  /**
   * Store reference for direct metadata updates.
   * Used to set initial access stats before recordAccess() batch flush.
   */
  store?: {
    getById(id: string): Promise<MemoryEntry | null>;
    update(entry: MemoryEntry): Promise<void>;
  };
}

// ============================================================================
// Main runner
// ============================================================================

/**
 * Run a single compaction pass over memories in the given scopes.
 *
 * @param store     Storage backend (must support fetchForCompaction + store + delete)
 * @param embedder  Used to embed merged text before storage
 * @param config    Compaction configuration
 * @param scopes    Scope filter; undefined = all scopes
 * @param logger    Optional logger
 * @param lifecycle Optional lifecycle dependencies for post-compaction entry initialization
 */
export async function runCompaction(
  store: CompactorStore,
  embedder: CompactorEmbedder,
  config: CompactionConfig,
  scopes?: string[],
  logger?: CompactorLogger,
  lifecycle?: CompactorLifecycle,
  llm?: LlmClient,
): Promise<CompactionResult> {
  const cutoff = Date.now() - config.minAgeDays * 24 * 60 * 60 * 1000;

  const entries = await store.fetchForCompaction(
    cutoff,
    scopes,
    config.maxMemoriesToScan,
  );

  if (entries.length === 0) {
    return {
      scanned: 0,
      clustersFound: 0,
      memoriesDeleted: 0,
      memoriesCreated: 0,
      dryRun: config.dryRun,
      llmRefined: 0,
      fallbackMerged: 0,
      failedClusters: 0,
    };
  }

  // Filter out entries without vectors (shouldn't happen but be safe)
  const valid = entries.filter((e) => e.vector && e.vector.length > 0);

  const plans = buildClusters(
    valid,
    config.similarityThreshold,
    config.minClusterSize,
  );

  if (config.dryRun) {
    logger?.info(
      `memory-compactor [dry-run]: scanned=${valid.length} clusters=${plans.length}`,
    );
    return {
      scanned: valid.length,
      clustersFound: plans.length,
      memoriesDeleted: 0,
      memoriesCreated: 0,
      dryRun: true,
      llmRefined: 0,
      fallbackMerged: plans.length,
      failedClusters: 0,
    };
  }

  let memoriesDeleted = 0;
  let memoriesCreated = 0;
  let llmRefined = 0;
  let fallbackMerged = 0;
  let failedClusters = 0;
  let llmAttempts = 0;
  const newEntryIds: string[] = [];
  const mergeMode = normalizeMergeMode(config.mergeMode);
  const deleteSourceMemories = normalizeDeleteSourceMemories(config.deleteSourceMemories);
  const maxLlmClustersPerRun = normalizeMaxLlmClustersPerRun(config.maxLlmClustersPerRun);

  for (const plan of plans) {
    const members = plan.memberIndices.map((i) => valid[i]);

    try {
      let merged = plan.merged;
      let refined: RefinedMemory | null = null;

      if (mergeMode === "llm" && llm && llmAttempts < maxLlmClustersPerRun) {
        llmAttempts++;
        try {
          refined = await refineClusterWithLlm(llm, members, plan.merged);
        } catch (err) {
          logger?.warn(
            `memory-compactor: LLM refinement failed for cluster of ${members.length}, falling back: ${String(err)}`,
          );
        }
      }

      if (refined) {
        merged = {
          text: refined.content,
          importance: refined.importance,
          category: refined.category,
          scope: plan.merged.scope,
          metadata: plan.merged.metadata,
        };
        llmRefined++;
      } else {
        fallbackMerged++;
      }

      // Embed the merged text
      const vector = await embedder.embedPassage(merged.text);

      // Build metadata with initial lifecycle stats
      // This breaks the accessCount=0 deadlock that would prevent tier promotion
      const now = Date.now();
      const initialMetadata = stringifySmartMetadata(
        buildSmartMetadata(
          {
            text: merged.text,
            category: merged.category,
            importance: merged.importance,
          },
          {
            l0_abstract: refined?.abstract ?? merged.text,
            l1_overview: refined?.overview ?? `- ${merged.text}`,
            l2_content: refined?.content ?? merged.text,
            memory_category: refined?.memoryCategory ?? reverseMapLegacyCategory(merged.category, merged.text),
            compacted: true,
            source_ids: members.map((m) => m.id),
            source_count: members.length,
            sourceCount: members.length,
            compact_reason: refined?.reason ?? "deterministic_similarity_merge",
            compacted_at: now,
            compactedAt: now,
            access_count: 1,
            source: "auto-capture",
            state: "confirmed",
            tier: merged.importance >= 0.8 ? "core" :
                  merged.importance >= 0.5 ? "working" : "peripheral",
          },
        ),
      );

      // Store merged entry
      const newEntry = await store.store({
        text: merged.text,
        vector,
        importance: merged.importance,
        category: merged.category,
        scope: merged.scope,
        metadata: initialMetadata,
      });
      newEntryIds.push(newEntry.id);
      memoriesCreated++;

      // Delete source entries
      if (deleteSourceMemories) {
        for (const m of members) {
          const deleted = await store.delete(m.id, [normalizeScope(m.scope)]);
          if (deleted) memoriesDeleted++;
        }
      }
    } catch (err) {
      failedClusters++;
      logger?.warn(
        `memory-compactor: failed to merge cluster of ${members.length}: ${String(err)}`,
      );
    }
  }

  // Record access for newly created entries via lifecycle dependencies
  // This ensures AccessTracker knows about them for future flush cycles
  if (lifecycle?.recordAccess && newEntryIds.length > 0) {
    try {
      lifecycle.recordAccess(newEntryIds);
      logger?.info(`memory-compactor: recorded access for ${newEntryIds.length} new entries`);
    } catch (err) {
      logger?.warn(`memory-compactor: failed to record access: ${String(err)}`);
    }
  }

  logger?.info(
    `memory-compactor: scanned=${valid.length} clusters=${plans.length} ` +
      `deleted=${memoriesDeleted} created=${memoriesCreated} ` +
      `llmRefined=${llmRefined} fallbackMerged=${fallbackMerged} failedClusters=${failedClusters}`,
  );

  return {
    scanned: valid.length,
    clustersFound: plans.length,
    memoriesDeleted,
    memoriesCreated,
    dryRun: false,
    llmRefined,
    fallbackMerged,
    failedClusters,
  };
}

// ============================================================================
// Cooldown helper
// ============================================================================

/**
 * Check whether enough time has passed since the last compaction run.
 * Uses a simple JSON file at `stateFile` to persist the last-run timestamp.
 */
export async function shouldRunCompaction(
  stateFile: string,
  cooldownHours: number,
): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(stateFile, "utf8");
    const state = JSON.parse(raw) as { lastRunAt?: number };
    if (typeof state.lastRunAt === "number") {
      const elapsed = Date.now() - state.lastRunAt;
      return elapsed >= cooldownHours * 60 * 60 * 1000;
    }
  } catch {
    // File doesn't exist or is malformed — treat as never run
  }
  return true;
}

export async function recordCompactionRun(stateFile: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}
