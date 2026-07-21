/**
 * Dedup pipeline for smart extraction — vector pre-filter + LLM decision.
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { LlmClient } from "./llm-client.js";
import type {
  CandidateMemory,
  DedupDecision,
  DedupResult,
} from "./memory-categories.js";
import { buildDedupPrompt } from "./extraction-prompts.js";
import { LLM_DEDUP_DECISION_SCHEMA } from "./llm-output-schemas.js";
import { inferAtomicBrandItemPreferenceSlot } from "./preference-slots.js";

// ============================================================================
// Constants
// ============================================================================

export const SIMILARITY_THRESHOLD = 0.7;
export const MAX_SIMILAR_FOR_PROMPT = 7;
export const VECTOR_SEARCH_LIMIT = 10;

/** Per-category similarity thresholds for dedup vector pre-filter. */
export const CATEGORY_SIMILARITY_THRESHOLDS: Record<string, number> = {
  preferences: 0.75,  // preferences are naturally分散, lower threshold
  entities: 0.80,     // entities moderate
  patterns: 0.85,     // patterns cluster tightly, higher threshold
  events: 0.80,
  cases: 0.80,
  profile: 0.82,
};

export function getSimilarityThreshold(category: string): number {
  return CATEGORY_SIMILARITY_THRESHOLDS[category] ?? SIMILARITY_THRESHOLD;
}
export const VALID_DECISIONS = new Set<string>([
  "create",
  "merge",
  "skip",
  "support",
  "contextualize",
  "contradict",
  "supersede",
]);

// ============================================================================
// Context
// ============================================================================

export interface DedupContext {
  store: MemoryStore;
  llm: LlmClient;
  log: { warn: (...args: unknown[]) => void };
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Two-stage dedup: vector similarity search → LLM decision.
 */
export async function deduplicate(
  ctx: DedupContext,
  candidate: CandidateMemory,
  candidateVector: number[],
  scopeFilter?: string[],
): Promise<DedupResult> {
  // Stage 1: Vector pre-filter — find similar active memories.
  // excludeInactive ensures the store over-fetches to fill N active slots,
  // preventing superseded history from crowding out the current fact.
  const activeSimilar = await ctx.store.vectorSearch(
    candidateVector,
    VECTOR_SEARCH_LIMIT,
    SIMILARITY_THRESHOLD,
    scopeFilter,
    { excludeInactive: true },
  );

  if (activeSimilar.length === 0) {
    return { decision: "create", reason: "No similar memories found" };
  }

  // Stage 1.5: Preference slot guard — same brand but different item
  // should always be stored as a new memory, not merged/skipped.
  // Example: "喜欢麦当劳的板烧鸡腿堡" and "喜欢麦当劳的麦辣鸡翅" are
  // different preferences even though they share the same brand.
  if (candidate.category === "preferences") {
    const candidateSlot = inferAtomicBrandItemPreferenceSlot(candidate.content);
    if (candidateSlot) {
      const allDifferentItem = activeSimilar.every((r) => {
        const existingSlot = inferAtomicBrandItemPreferenceSlot(r.entry.text);
        // If existing is not a brand-item preference, let LLM decide
        if (!existingSlot) return false;
        // Same brand, different item → should not be deduped
        return existingSlot.brand === candidateSlot.brand && existingSlot.item !== candidateSlot.item;
      });
      if (allDifferentItem) {
        return { decision: "create", reason: "Same brand but different item-level preference (preference-slot guard)" };
      }
    }
  }

  // Stage 2: LLM decision
  return llmDedupDecision(ctx, candidate, activeSimilar);
}

export async function llmDedupDecision(
  ctx: DedupContext,
  candidate: CandidateMemory,
  similar: MemorySearchResult[],
): Promise<DedupResult> {
  const topSimilar = similar.slice(0, MAX_SIMILAR_FOR_PROMPT);
  const existingFormatted = topSimilar
    .map((r, i) => {
      // Extract summary from metadata if available, fallback to text
      let metaObj: Record<string, unknown> = {};
      try {
        metaObj = JSON.parse(r.entry.metadata || "{}");
      } catch { }
      const abstract = (metaObj.summary as string) || r.entry.text;
      const content = (metaObj.content as string) || r.entry.text;
      // 2026-07-21 review (P0-B.L2): surface the first 8 hex chars of each
      // memory's id so the LLM can echo it back as match_id_prefix; the
      // server then re-verifies the prefix against topSimilar[idx-1].entry.id
      // to defeat prompt-injection attacks that supply an arbitrary index.
      const idPrefix = r.entry.id.replace(/-/g, "").slice(0, 8);
      return `${i + 1}. [${(metaObj.memory_category as string) || r.entry.category}] (id:${idPrefix}) ${abstract}\n   Content: ${content.slice(0, 600)}\n   Score: ${r.score.toFixed(3)}`;
    })
    .join("\n");

  const prompt = buildDedupPrompt(
    candidate.abstract,
    candidate.content,
    existingFormatted,
  );

  try {
    const data = await ctx.llm.completeJson<{
      decision: string;
      reason: string;
      match_index?: number;
      match_id_prefix?: string;
    }>(prompt, "dedup-decision", LLM_DEDUP_DECISION_SCHEMA);

    if (!data) {
      ctx.log.warn(
        "mymem：智能提取去重 LLM 返回不可解析结果，默认按新建处理",
      );
      return { decision: "create", reason: "LLM response unparseable" };
    }

    const decision = (data.decision?.toLowerCase() ??
      "create") as DedupDecision;
    if (!VALID_DECISIONS.has(decision)) {
      return {
        decision: "create",
        reason: `Unknown decision: ${data.decision}`,
      };
    }

    // Decisions that require pointing at a specific existing memory.
    const targetDecisions = new Set([
      "merge",
      "support",
      "contextualize",
      "contradict",
      "supersede",
    ]);
    const destructiveDecisions = new Set(["supersede", "contradict"]);

    // Resolve merge target from LLM's match_index (1-based).
    const idx = data.match_index;
    const hasValidIndex =
      typeof idx === "number" && idx >= 1 && idx <= topSimilar.length;
    const matchEntry = hasValidIndex ? topSimilar[idx - 1] : topSimilar[0];

    // 2026-07-21 review (P0-B.L2): if the LLM points at a specific existing
    // memory, also require it to echo the first 8 hex chars of that memory's
    // id. The server re-verifies the prefix against topSimilar[idx-1].entry.id
    // so a prompt injection that supplies an arbitrary match_index cannot
    // steer the destructive action without also guessing a valid 32-bit id.
    let idPrefixMatches = true;
    if (targetDecisions.has(decision) && hasValidIndex) {
      const llmPrefix = (data.match_id_prefix ?? "").toLowerCase().trim();
      const expectedPrefix = matchEntry.entry.id.replace(/-/g, "").slice(0, 8);
      if (!llmPrefix || llmPrefix !== expectedPrefix) {
        idPrefixMatches = false;
        ctx.log.warn(
          `mymem：智能提取去重决策 ${decision} 的 match_id_prefix 与目标 memory 不匹配（LLM=${llmPrefix}，expected=${expectedPrefix}），已降级为新建`,
        );
      }
    }

    // For destructive decisions (supersede/contradict), missing match_index or
    // mismatched id prefix is unsafe — we could mutate the wrong memory.
    // Degrade to create. This is the L2 layer of defense: even if the LLM
    // is prompt-injected into echoing a wrong index, the id prefix check
    // here keeps the operation from succeeding without a real id.
    if (destructiveDecisions.has(decision) && (!hasValidIndex || !idPrefixMatches)) {
      return {
        decision: "create",
        reason: `${decision} degraded: invalid match_index or id prefix mismatch`,
      };
    }

    // For non-destructive target decisions (merge/support/contextualize),
    // also degrade if the id prefix does not match — the candidate's intent
    // was clearly to point at a specific memory, and a wrong target would
    // silently merge the candidate into an unrelated existing memory.
    if (
      !destructiveDecisions.has(decision) &&
      targetDecisions.has(decision) &&
      !idPrefixMatches
    ) {
      return {
        decision: "create",
        reason: `${decision} degraded: id prefix mismatch`,
      };
    }

    return {
      decision,
      reason: data.reason ?? "",
      matchId: targetDecisions.has(decision) ? matchEntry?.entry.id : undefined,
      contextLabel: typeof (data as Record<string, unknown>).context_label === "string" ? (data as Record<string, unknown>).context_label as string : undefined,
    };
  } catch (err) {
    ctx.log.warn(
      `mymem：智能提取去重 LLM 失败：${String(err)}`,
    );
    return { decision: "create", reason: `LLM failed: ${String(err)}` };
  }
}
