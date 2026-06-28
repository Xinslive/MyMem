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
import { LLM_MERGE_MEMORY_SCHEMA } from "./llm-output-schemas.js";
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
import { defaultLearningKindPatch } from "./learning-memory.js";
import { redactSecrets } from "./session-utils.js";

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
 * Store a candidate memory as a new entry with summary/content metadata.
 */
export async function storeCandidate(
  ctx: HandlerContext,
  candidate: CandidateMemory,
  vector: number[],
  sessionKey: string,
  targetScope: string,
  _admissionAudit?: AdmissionAuditRecord,
): Promise<void> {
  // Map 6-category to existing store categories for backward compatibility
  const storeCategory = ctx.mapToStoreCategory(candidate.category);

  // Redact true secrets from both summary and content before persisting.
  // The extraction prompt is also scrubbed, but LLM echoes are not guaranteed;
  // this is the second line of defense against credentials ending up in long-term memory.
  const safeAbstract = redactSecrets(candidate.abstract);
  const safeContent = redactSecrets(candidate.content);

  const classifyText = safeContent || safeAbstract;
  const metadata = stringifySmartMetadata(
    buildSmartMetadata(
      {
        text: safeAbstract,
        category: ctx.mapToStoreCategory(candidate.category),
      },
      {
        summary: safeAbstract,
        content: safeContent,
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
        ...defaultLearningKindPatch(candidate.category),
        memory_temporal_type: classifyTemporal(classifyText),
        valid_until: inferExpiry(classifyText),
      },
    ),
  );

  await ctx.store.store({
    text: safeAbstract, // Summary used as the searchable text
    vector,
    category: storeCategory,
    scope: targetScope,
    importance: ctx.getDefaultImportance(candidate.category),
    metadata,
  });

  ctx.log.info(
    `mymem：智能提取新建记忆 [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
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
        `mymem：智能提取准入拒绝 profile [${candidate.abstract.slice(0, 60)}]，原因：${profileAdmission.audit.reason}`,
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
  let existingContent = "";

  try {
    const existing = await ctx.store.getById(matchId, scopeFilter);
    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      existingAbstract = meta.summary || existing.text;
      existingContent = meta.content || existing.text;
    }
  } catch {
    // Fallback: store as new
    ctx.log.warn(
      `mymem：智能提取无法读取已有记忆 ${matchId}，将作为新记忆存储`,
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
    existingContent,
    candidate.abstract,
    candidate.content,
    candidate.category,
  );

  const merged = await ctx.llm.completeJson<{
    abstract: string;
    content: string;
  }>(prompt, "merge-memory", LLM_MERGE_MEMORY_SCHEMA);

  if (!merged) {
    ctx.log.warn("mymem：智能提取 LLM 合并失败，已跳过合并");
    return;
  }

  // Defense in depth: LLM may have re-introduced secrets in the merged output.
  // Scrub before persisting the merged memory.
  const safeMergedAbstract = redactSecrets(merged.abstract);
  const safeMergedContent = redactSecrets(merged.content);

  // Re-embed the merged content
  const mergedText = `${safeMergedAbstract} ${safeMergedContent}`;
  const newVector = await ctx.embedder.embed(mergedText);

  // Update existing memory via store.update()
  const existing = await ctx.store.getById(matchId, scopeFilter);
  const metadata = stringifySmartMetadata(
    withAdmissionAudit(
      ctx,
      buildSmartMetadata(existing ?? { text: safeMergedAbstract }, {
        summary: safeMergedAbstract,
        content: safeMergedContent,
        memory_category: candidate.category,
        ...defaultLearningKindPatch(candidate.category),
        tier: "working",
        confidence: 0.8,
      }),
      admissionAudit,
    ),
  );

  await ctx.store.update(
    matchId,
    {
      text: safeMergedAbstract,
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
    `mymem：智能提取合并记忆 [${candidate.category}]${contextLabel ? ` [${contextLabel}]` : ""} 到 ${matchId.slice(0, 8)}`,
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
  _admissionAudit?: AdmissionAuditRecord,
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
          summary: candidate.abstract,
          content: candidate.content,
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
          ...defaultLearningKindPatch(candidate.category),
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
    `mymem：智能提取替换旧记忆 [${candidate.category}] ${matchId.slice(0, 8)} -> ${created.id.slice(0, 8)}`,
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
    `mymem：智能提取记录支持证据 [${contextLabel || "general"}] 到 ${matchId.slice(0, 8)}，原因：${reason}`,
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
    summary: candidate.abstract,
    content: candidate.content,
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
    ...defaultLearningKindPatch(candidate.category),
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
    `mymem：智能提取新增上下文记忆 [${contextLabel || "general"}]，关联到 ${matchId.slice(0, 8)}`,
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
    summary: candidate.abstract,
    content: candidate.content,
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
    ...defaultLearningKindPatch(candidate.category),
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
    `mymem：智能提取记录矛盾证据 [${contextLabel || "general"}] 到 ${matchId.slice(0, 8)}，并已新建记忆`,
  );
}
