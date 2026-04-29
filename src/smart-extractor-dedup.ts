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
import { inferAtomicBrandItemPreferenceSlot } from "./preference-slots.js";

// ============================================================================
// Constants
// ============================================================================

export const SIMILARITY_THRESHOLD = 0.7;
export const MAX_SIMILAR_FOR_PROMPT = 3;
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
    5,
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
      // Extract L0 abstract from metadata if available, fallback to text
      let metaObj: Record<string, unknown> = {};
      try {
        metaObj = JSON.parse(r.entry.metadata || "{}");
      } catch { }
      const abstract = (metaObj.l0_abstract as string) || r.entry.text;
      const overview = (metaObj.l1_overview as string) || "";
      return `${i + 1}. [${(metaObj.memory_category as string) || r.entry.category}] ${abstract}\n   Overview: ${overview}\n   Score: ${r.score.toFixed(3)}`;
    })
    .join("\n");

  const prompt = buildDedupPrompt(
    candidate.abstract,
    candidate.overview,
    candidate.content,
    existingFormatted,
  );

  try {
    const data = await ctx.llm.completeJson<{
      decision: string;
      reason: string;
      match_index?: number;
    }>(prompt, "dedup-decision");

    if (!data) {
      ctx.log.warn(
        "mymem: smart-extractor: dedup LLM returned unparseable response, defaulting to CREATE",
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

    // Resolve merge target from LLM's match_index (1-based)
    const idx = data.match_index;
    const hasValidIndex = typeof idx === "number" && idx >= 1 && idx <= topSimilar.length;
    const matchEntry = hasValidIndex
      ? topSimilar[idx - 1]
      : topSimilar[0];

    // For destructive decisions (supersede), missing match_index is
    // unsafe — we could invalidate the wrong memory. Degrade to create.
    const destructiveDecisions = new Set(["supersede", "contradict"]);
    if (destructiveDecisions.has(decision) && !hasValidIndex) {
      ctx.log.warn(
        `mymem: smart-extractor: ${decision} decision has missing/invalid match_index (${idx}), degrading to create`,
      );
      return {
        decision: "create",
        reason: `${decision} degraded: missing match_index`,
      };
    }

    return {
      decision,
      reason: data.reason ?? "",
      matchId: ["merge", "support", "contextualize", "contradict", "supersede"].includes(decision) ? matchEntry?.entry.id : undefined,
      contextLabel: typeof (data as any).context_label === "string" ? (data as any).context_label : undefined,
    };
  } catch (err) {
    ctx.log.warn(
      `mymem: smart-extractor: dedup LLM failed: ${String(err)}`,
    );
    return { decision: "create", reason: `LLM failed: ${String(err)}` };
  }
}
