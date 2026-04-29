/**
 * RRF (Reciprocal Rank Fusion) score fusion for hybrid retrieval.
 */

import type { MemorySearchResult } from "./store.js";
import type { RetrievalResult } from "./retriever-types.js";
import type { BatchIdStore } from "./retriever-types.js";
import type { Logger } from "./logger.js";
import { clamp01, throwIfAborted, resolveUnlessAborted } from "./retriever-utils.js";

// ============================================================================
// RRF Fusion
// ============================================================================

export async function fuseResults(
  vectorResults: Array<MemorySearchResult & { rank: number }>,
  bm25Results: Array<MemorySearchResult & { rank: number }>,
  config: { vectorWeight: number; bm25Weight: number },
  store: { hasId: (id: string) => Promise<boolean> } & Partial<BatchIdStore>,
  logger: Pick<Logger, "debug" | "warn">,
  signal?: AbortSignal,
): Promise<RetrievalResult[]> {
  throwIfAborted(signal);

  // Create maps for quick lookup
  const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
  const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

  vectorResults.forEach((result) => {
    vectorMap.set(result.entry.id, result);
  });

  bm25Results.forEach((result) => {
    bm25Map.set(result.entry.id, result);
  });

  // Get all unique document IDs
  const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);
  const ghostCheckIds = [...allIds].filter((id) => !vectorMap.has(id) && bm25Map.has(id));
  const missingBm25OnlyIds = new Set<string>();

  if (ghostCheckIds.length > 0) {
    const hasIds = store.hasIds;
    if (typeof hasIds === "function") {
      try {
        const existingIds = await resolveUnlessAborted(hasIds.call(store, ghostCheckIds), signal);
        throwIfAborted(signal);
        for (const id of ghostCheckIds) {
          if (!existingIds.has(id)) missingBm25OnlyIds.add(id);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        logger.debug(`[Retriever] batch hasIds check failed: ${err}`);
      }
    } else {
      const existenceResults = await resolveUnlessAborted(
        Promise.allSettled(
          ghostCheckIds.map(async (id) => {
            throwIfAborted(signal);
            return { id, exists: await store.hasId(id) };
          }),
        ),
        signal,
      );
      throwIfAborted(signal);

      for (let index = 0; index < existenceResults.length; index++) {
        const result = existenceResults[index];
        const id = ghostCheckIds[index];
        if (result.status === "fulfilled") {
          if (!result.value.exists) missingBm25OnlyIds.add(result.value.id);
        } else {
          // If hasId fails, keep the result (fail-open)
          logger.debug(`[Retriever] hasId check failed for ${id}: ${result.reason}`);
        }
      }
    }
  }

  // Calculate RRF scores
  const fusedResults: RetrievalResult[] = [];

  for (const id of allIds) {
    throwIfAborted(signal);
    const vectorResult = vectorMap.get(id);
    const bm25Result = bm25Map.get(id);

    // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
    // deleted but whose FTS index entry lingers until the next index rebuild.
    // Validate that the entry actually exists in the store before including it.
    if (!vectorResult && bm25Result && missingBm25OnlyIds.has(id)) continue;

    // Use the result with more complete data (prefer vector result if both exist)
    const baseResult = vectorResult || bm25Result!;

    // Use vector similarity as the base score.
    // BM25 hit acts as a bonus (keyword match confirms relevance).
    const vectorScore = vectorResult ? vectorResult.score : 0;
    const bm25Score = bm25Result ? bm25Result.score : 0;
    // Weighted fusion: vectorWeight/bm25Weight directly control score blending.
    // BM25 high-score floor (>= 0.75) preserves exact keyword matches
    // (e.g. API keys, ticket numbers) that may have low vector similarity.
    const weightedFusion = (vectorScore * config.vectorWeight)
                         + (bm25Score * config.bm25Weight);
    const fusedScore = vectorResult
      ? clamp01(
        Math.max(
          weightedFusion,
          bm25Score >= 0.75 ? bm25Score * 0.92 : 0,
        ),
        0.1,
      )
      : clamp01(bm25Result!.score, 0.1);

    fusedResults.push({
      entry: baseResult.entry,
      score: fusedScore,
      sources: {
        vector: vectorResult
          ? { score: vectorResult.score, rank: vectorResult.rank }
          : undefined,
        bm25: bm25Result
          ? { score: bm25Result.score, rank: bm25Result.rank }
          : undefined,
        fused: { score: fusedScore },
      },
    });
  }

  // Sort by fused score descending
  return fusedResults.sort((a, b) => b.score - a.score);
}
