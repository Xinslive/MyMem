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

  // Classic Reciprocal Rank Fusion (RRF): score = Σ weight_i / (k + rank_i).
  // Rank-based scoring is scale-invariant — no normalization needed between
  // vector and BM25 score distributions. k=60 is the standard constant from
  // the original RRF paper (Cormack et al., 2009).
  const RRF_K = 60;

  // Phase 1: Compute raw RRF scores and collect results
  const rawResults: Array<{
    entry: RetrievalResult["entry"];
    rrfRaw: number;
    bm25Floor: number;
    isBm25Only: boolean;
    weightedScore: number;
    bm25RawScore: number;
    sources: RetrievalResult["sources"];
  }> = [];
  let maxRrfRaw = 0;

  for (const id of allIds) {
    throwIfAborted(signal);
    const vectorResult = vectorMap.get(id);
    const bm25Result = bm25Map.get(id);

    // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
    // deleted but whose FTS index entry lingers until the next index rebuild.
    if (!vectorResult && bm25Result && missingBm25OnlyIds.has(id)) continue;

    const baseResult = vectorResult || bm25Result!;
    const vectorRRF = vectorResult
      ? config.vectorWeight / (RRF_K + vectorResult.rank)
      : 0;
    const bm25RRF = bm25Result
      ? config.bm25Weight / (RRF_K + bm25Result.rank)
      : 0;
    const rrfRaw = vectorRRF + bm25RRF;
    if (rrfRaw > maxRrfRaw) maxRrfRaw = rrfRaw;
    const presentWeight =
      (vectorResult ? config.vectorWeight : 0) +
      (bm25Result ? config.bm25Weight : 0);
    const weightedScore = presentWeight > 0
      ? (
          (vectorResult ? vectorResult.score * config.vectorWeight : 0) +
          (bm25Result ? bm25Result.score * config.bm25Weight : 0)
        ) / presentWeight
      : 0;

    rawResults.push({
      entry: baseResult.entry,
      rrfRaw,
      bm25Floor: bm25Result && bm25Result.score >= 0.75
        ? bm25Result.score * 0.92
        : 0,
      isBm25Only: !vectorResult,
      weightedScore,
      bm25RawScore: bm25Result?.score ?? 0,
      sources: {
        vector: vectorResult
          ? { score: vectorResult.score, rank: vectorResult.rank }
          : undefined,
        bm25: bm25Result
          ? { score: bm25Result.score, rank: bm25Result.rank }
          : undefined,
        fused: { score: 0 }, // filled in phase 2
      },
    });
  }

  // Phase 2: Normalize RRF scores to [0, 1] and apply BM25 floor protection.
  // RRF raw scores are tiny (e.g. 0.016 for rank 1 with k=60), so we scale
  // them to fill [0, 1] relative to the best score in this batch.
  const rrfScale = maxRrfRaw > 0 ? 1 / maxRrfRaw : 1;
  const fusedResults: RetrievalResult[] = [];

  for (const raw of rawResults) {
    // BM25-only results use raw BM25 score (already in [0, 1])
    const rrfNormalized = raw.isBm25Only
      ? raw.bm25RawScore
      : raw.rrfRaw * rrfScale;
    const scoreBase = raw.isBm25Only
      ? rrfNormalized
      : (rrfNormalized * 0.35 + raw.weightedScore * 0.65);

    // BM25 high-score floor protects exact keyword matches
    const fusedScore = clamp01(
      Math.max(scoreBase, raw.bm25Floor),
      0.1,
    );

    raw.sources.fused = { score: fusedScore };
    fusedResults.push({
      entry: raw.entry,
      score: fusedScore,
      sources: raw.sources,
    });
  }

  // Sort by fused score descending
  return fusedResults.sort((a, b) => b.score - a.score);
}
