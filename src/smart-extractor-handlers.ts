/**
 * Handler functions for smart extraction decisions (merge, supersede, support,
 * contextualize, contradict). Extracted from SmartExtractor as free functions
 * that receive a context object.
 */

import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { LlmClient } from "./llm-client.js";
import type { AdmissionController, AdmissionAuditRecord } from "./admission-control.js";
import type { CandidateMemory, MemoryCategory } from "./memory-categories.js";
import { buildMergePrompt } from "./extraction-prompts.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
  parseSupportInfo,
  updateSupportStats,
} from "./smart-metadata.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";

// ============================================================================
// Context
// ============================================================================

type StoreCategory = "preference" | "fact" | "decision" | "entity" | "other";

export interface HandlerContext {
  store: MemoryStore;
  embedder: Embedder;
  llm: LlmClient;
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
  admissionController: AdmissionController | null;
  persistAdmissionAudit: boolean;
  mapToStoreCategory: (c: MemoryCategory) => StoreCategory;
  getDefaultImportance: (c: MemoryCategory) => number;
  recordRejectedAdmission: (
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
    audit: AdmissionAuditRecord & { decision: "reject" },
  ) => Promise<void>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map 6-category to existing 5-category store type for backward compatibility.
 */
export function mapToStoreCategory(
  category: MemoryCategory,
): "preference" | "fact" | "decision" | "entity" | "other" {
  switch (category) {
    case "profile":
      return "fact";
    case "preferences":
      return "preference";
    case "entities":
      return "entity";
    case "events":
      return "decision";
    case "cases":
      return "fact";
    case "patterns":
      return "other";
    default:
      return "other";
  }
}

/**
 * Get default importance score by category.
 */
export function getDefaultImportance(category: MemoryCategory): number {
  switch (category) {
    case "profile":
      return 0.9; // Identity is very important
    case "preferences":
      return 0.8;
    case "entities":
      return 0.7;
    case "events":
      return 0.6;
    case "cases":
      return 0.8; // Problem-solution pairs are high value
    case "patterns":
      return 0.85; // Reusable processes are high value
    default:
      return 0.5;
  }
}

/**
 * Embed admission audit record into metadata if audit persistence is enabled.
 */
function withAdmissionAudit<T extends Record<string, unknown>>(
  ctx: HandlerContext,
  metadata: T,
  admissionAudit?: AdmissionAuditRecord,
): T & { admission_control?: AdmissionAuditRecord } {
  if (!admissionAudit || !ctx.persistAdmissionAudit) {
    return metadata as T & { admission_control?: AdmissionAuditRecord };
  }
  return { ...metadata, admission_control: admissionAudit };
}

/**
 * Store a candidate memory as a new entry with L0/L1/L2 metadata.
 */
export async function storeCandidate(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  vector: number[],
  sessionKey: string,
  targetScope: string,
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  // Map 6-category to existing store categories for backward compatibility
  const storeCategory = ctx.mapToStoreCategory(candidate.category);

  const classifyText = candidate.content || candidate.abstract;
  const metadata = stringifySmartMetadata(
    buildSmartMetadata(
      {
        text: candidate.abstract,
        category: ctx.mapToStoreCategory(candidate.category),
      },
      {
        l0_abstract: candidate.abstract,
        l1_overview: candidate.overview,
        l2_content: candidate.content,
        memory_category: candidate.category,
        tier: "working",
        access_count: 0,
        confidence: 0.7,
        source_session: sessionKey,
        source: "auto-capture",
        state: "confirmed", // #350: write confirmed to unblock auto-recall
        memory_layer: "working",
        injected_count: 0,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
        memory_temporal_type: classifyTemporal(classifyText),
        valid_until: inferExpiry(classifyText),
      },
    ),
  );

  await ctx.store.store({
    text: candidate.abstract, // L0 used as the searchable text
    vector,
    category: storeCategory,
    scope: targetScope,
    importance: ctx.getDefaultImportance(candidate.category),
    metadata,
  });

  ctx.log.info(
    `mymem: smart-extractor: created [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
  );
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Profile always-merge: read existing profile, merge with LLM, upsert.
 */
export async function handleProfileMerge(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  conversationText: string,
  sessionKey: string,
  targetScope: string,
  scopeFilter?: string[],
  admissionAudit?: AdmissionAuditRecord,
): Promise<"merged" | "created" | "rejected"> {
  // Find existing profile memory by category
  const embeddingText = `${candidate.abstract} ${candidate.content}`;
  const vector = await ctx.embedder.embed(embeddingText);

  // Run admission control for profile candidates (they skip the main dedup path)
  if (!admissionAudit && ctx.admissionController && vector && vector.length > 0) {
    const profileAdmission = await ctx.admissionController.evaluate({
      candidate,
      candidateVector: vector,
      conversationText,
      scopeFilter: scopeFilter ?? [targetScope],
    });
    if (profileAdmission.decision === "reject") {
      ctx.log.warn(
        `mymem: smart-extractor: admission rejected profile [${candidate.abstract.slice(0, 60)}] — ${profileAdmission.audit.reason}`,
      );
      await ctx.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter ?? [targetScope], profileAdmission.audit as AdmissionAuditRecord & { decision: "reject" });
      return "rejected";
    }
    admissionAudit = profileAdmission.audit;
  }

  // Search for existing profile memories
  const existing = await ctx.store.vectorSearch(
    vector || [],
    1,
    0.3,
    scopeFilter,
  );
  const profileMatch = existing.find((r) => {
    try {
      const meta = JSON.parse(r.entry.metadata || "{}");
      return meta.memory_category === "profile";
    } catch {
      return false;
    }
  });

  if (profileMatch) {
    await handleMerge(
      ctx,
      candidate,
      profileMatch.entry.id,
      targetScope,
      scopeFilter,
      undefined,
      admissionAudit,
    );
    return "merged";
  } else {
    // No existing profile — create new
    await storeCandidate(ctx, candidate, vector || [], sessionKey, targetScope, admissionAudit);
    return "created";
  }
}

/**
 * Merge a candidate into an existing memory using LLM.
 */
export async function handleMerge(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  matchId: string,
  targetScope: string,
  scopeFilter?: string[],
  contextLabel?: string,
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  let existingAbstract = "";
  let existingOverview = "";
  let existingContent = "";

  try {
    const existing = await ctx.store.getById(matchId, scopeFilter);
    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      existingAbstract = meta.l0_abstract || existing.text;
      existingOverview = meta.l1_overview || "";
      existingContent = meta.l2_content || existing.text;
    }
  } catch {
    // Fallback: store as new
    ctx.log.warn(
      `mymem: smart-extractor: could not read existing memory ${matchId}, storing as new`,
    );
    const vector = await ctx.embedder.embed(
      `${candidate.abstract} ${candidate.content}`,
    );
    await storeCandidate(
      ctx,
      candidate,
      vector || [],
      "merge-fallback",
      targetScope,
    );
    return;
  }

  // Call LLM to merge
  const prompt = buildMergePrompt(
    existingAbstract,
    existingOverview,
    existingContent,
    candidate.abstract,
    candidate.overview,
    candidate.content,
    candidate.category,
  );

  const merged = await ctx.llm.completeJson<{
    abstract: string;
    overview: string;
    content: string;
  }>(prompt, "merge-memory");

  if (!merged) {
    ctx.log.warn("mymem: smart-extractor: merge LLM failed, skipping merge");
    return;
  }

  // Re-embed the merged content
  const mergedText = `${merged.abstract} ${merged.content}`;
  const newVector = await ctx.embedder.embed(mergedText);

  // Update existing memory via store.update()
  const existing = await ctx.store.getById(matchId, scopeFilter);
  const metadata = stringifySmartMetadata(
    withAdmissionAudit(
      ctx,
      buildSmartMetadata(existing ?? { text: merged.abstract }, {
        l0_abstract: merged.abstract,
        l1_overview: merged.overview,
        l2_content: merged.content,
        memory_category: candidate.category,
        tier: "working",
        confidence: 0.8,
      }),
      admissionAudit,
    ),
  );

  await ctx.store.update(
    matchId,
    {
      text: merged.abstract,
      vector: newVector,
      metadata,
    },
    scopeFilter,
  );

  // Update support stats on the merged memory
  try {
    const updatedEntry = await ctx.store.getById(matchId, scopeFilter);
    if (updatedEntry) {
      const meta = parseSmartMetadata(updatedEntry.metadata, updatedEntry);
      const supportInfo = parseSupportInfo(meta.support_info);
      const updated = updateSupportStats(supportInfo, contextLabel, "support");
      const finalMetadata = stringifySmartMetadata({ ...meta, support_info: updated });
      await ctx.store.update(matchId, { metadata: finalMetadata }, scopeFilter);
    }
  } catch {
    // Non-critical: merge succeeded, support stats update is best-effort
  }

  ctx.log.info(
    `mymem: smart-extractor: merged [${candidate.category}]${contextLabel ? ` [${contextLabel}]` : ""} into ${matchId.slice(0, 8)}`,
  );
}

/**
 * Handle SUPERSEDE: preserve the old record as historical but mark it as no
 * longer current, then create the new active fact.
 */
export async function handleSupersede(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  vector: number[],
  matchId: string,
  sessionKey: string,
  targetScope: string,
  scopeFilter: string[],
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  const existing = await ctx.store.getById(matchId, scopeFilter);
  if (!existing) {
    await storeCandidate(ctx, candidate, vector, sessionKey, targetScope);
    return;
  }

  const now = Date.now();
  const existingMeta = parseSmartMetadata(existing.metadata, existing);
  const factKey =
    existingMeta.fact_key ?? deriveFactKey(candidate.category, candidate.abstract);
  const storeCategory = ctx.mapToStoreCategory(candidate.category);
  const supersedeClassifyText = candidate.content || candidate.abstract;
  const created = await ctx.store.store({
    text: candidate.abstract,
    vector,
    category: storeCategory,
    scope: targetScope,
    importance: ctx.getDefaultImportance(candidate.category),
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        {
          text: candidate.abstract,
          category: storeCategory,
        },
        {
          l0_abstract: candidate.abstract,
          l1_overview: candidate.overview,
          l2_content: candidate.content,
          memory_category: candidate.category,
          tier: "working",
          access_count: 0,
          confidence: 0.7,
          source_session: sessionKey,
          source: "auto-capture",
          state: "confirmed", // #350: write confirmed to unblock auto-recall
          memory_layer: "working",
          injected_count: 0,
          bad_recall_count: 0,
          suppressed_until_turn: 0,
          valid_from: now,
          fact_key: factKey,
          supersedes: matchId,
          relations: appendRelation([], {
            type: "supersedes",
            targetId: matchId,
          }),
          memory_temporal_type: classifyTemporal(supersedeClassifyText),
          valid_until: inferExpiry(supersedeClassifyText),
        },
      ),
    ),
  });

  const invalidatedMetadata = buildSmartMetadata(existing, {
    fact_key: factKey,
    invalidated_at: now,
    superseded_by: created.id,
    relations: appendRelation(existingMeta.relations, {
      type: "superseded_by",
      targetId: created.id,
    }),
  });

  await ctx.store.update(
    matchId,
    { metadata: stringifySmartMetadata(invalidatedMetadata) },
    scopeFilter,
  );

  ctx.log.info(
    `mymem: smart-extractor: superseded [${candidate.category}] ${matchId.slice(0, 8)} -> ${created.id.slice(0, 8)}`,
  );
}

/**
 * Handle SUPPORT: update support stats on existing memory for a specific context.
 */
export async function handleSupport(
  ctx: HandlerContext,
  matchId: string,
  source: { session: string; timestamp: number },
  reason: string,
  contextLabel?: string,
  scopeFilter?: string[],
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  const existing = await ctx.store.getById(matchId, scopeFilter);
  if (!existing) return;

  const meta = parseSmartMetadata(existing.metadata, existing);
  const supportInfo = parseSupportInfo(meta.support_info);
  const updated = updateSupportStats(supportInfo, contextLabel, "support");
  meta.support_info = updated;

  await ctx.store.update(
    matchId,
    { metadata: stringifySmartMetadata(withAdmissionAudit(ctx, meta, admissionAudit)) },
    scopeFilter,
  );

  ctx.log.info(
    `mymem: smart-extractor: support [${contextLabel || "general"}] on ${matchId.slice(0, 8)} — ${reason}`,
  );
}

/**
 * Handle CONTEXTUALIZE: create a new entry that adds situational nuance,
 * linked to the original via a relation in metadata.
 */
export async function handleContextualize(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  vector: number[],
  matchId: string,
  sessionKey: string,
  targetScope: string,
  scopeFilter?: string[],
  contextLabel?: string,
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  const storeCategory = ctx.mapToStoreCategory(candidate.category);
  const metadata = stringifySmartMetadata(withAdmissionAudit(ctx, {
    l0_abstract: candidate.abstract,
    l1_overview: candidate.overview,
    l2_content: candidate.content,
    memory_category: candidate.category,
    tier: "working" as const,
    access_count: 0,
    confidence: 0.7,
    last_accessed_at: Date.now(),
    source_session: sessionKey,
    source: "auto-capture" as const,
    state: "confirmed" as const, // #350: write confirmed to unblock auto-recall
    memory_layer: "working" as const,
    injected_count: 0,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
    contexts: contextLabel ? [contextLabel] : [],
    relations: [{ type: "contextualizes", targetId: matchId }],
  }, admissionAudit));

  await ctx.store.store({
    text: candidate.abstract,
    vector,
    category: storeCategory,
    scope: targetScope,
    importance: ctx.getDefaultImportance(candidate.category),
    metadata,
  });

  ctx.log.info(
    `mymem: smart-extractor: contextualize [${contextLabel || "general"}] new entry linked to ${matchId.slice(0, 8)}`,
  );
}

/**
 * Handle CONTRADICT: create contradicting entry + record contradiction evidence
 * on the original memory's support stats.
 */
export async function handleContradict(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  vector: number[],
  matchId: string,
  sessionKey: string,
  targetScope: string,
  scopeFilter?: string[],
  contextLabel?: string,
  admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  // 1. Record contradiction on the existing memory
  const existing = await ctx.store.getById(matchId, scopeFilter);
  if (existing) {
    const meta = parseSmartMetadata(existing.metadata, existing);
    const supportInfo = parseSupportInfo(meta.support_info);
    const updated = updateSupportStats(supportInfo, contextLabel, "contradict");
    meta.support_info = updated;
    await ctx.store.update(
      matchId,
      { metadata: stringifySmartMetadata(meta) },
      scopeFilter,
    );
  }

  // 2. Store the contradicting entry as a new memory
  const storeCategory = ctx.mapToStoreCategory(candidate.category);
  const metadata = stringifySmartMetadata(withAdmissionAudit(ctx, {
    l0_abstract: candidate.abstract,
    l1_overview: candidate.overview,
    l2_content: candidate.content,
    memory_category: candidate.category,
    tier: "working" as const,
    access_count: 0,
    confidence: 0.7,
    last_accessed_at: Date.now(),
    source_session: sessionKey,
    source: "auto-capture" as const,
    state: "confirmed" as const, // #350: write confirmed to unblock auto-recall
    memory_layer: "working" as const,
    injected_count: 0,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
    contexts: contextLabel ? [contextLabel] : [],
    relations: [{ type: "contradicts", targetId: matchId }],
  }, admissionAudit));

  await ctx.store.store({
    text: candidate.abstract,
    vector,
    category: storeCategory,
    scope: targetScope,
    importance: ctx.getDefaultImportance(candidate.category),
    metadata,
  });

  ctx.log.info(
    `mymem: smart-extractor: contradict [${contextLabel || "general"}] on ${matchId.slice(0, 8)}, new entry created`,
  );
}
