/**
 * Rerank provider adapters and reranking logic.
 */

import type { RetrievalConfig, RetrievalResult } from "./retriever-types.js";
import type { Logger } from "./logger.js";
import { clamp01, clamp01WithFloor } from "./retriever-utils.js";
import { cosineSimilarity } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export type RerankProvider =
  | "jina"
  | "siliconflow"
  | "voyage"
  | "pinecone"
  | "dashscope"
  | "tei";

export interface RerankItem {
  index: number;
  score: number;
}

// ============================================================================
// Provider Request Builder
// ============================================================================

/** Build provider-specific request headers and body */
export function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  candidates: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "tei":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          query,
          texts: candidates,
        },
      };
    case "dashscope":
      // DashScope wraps query+documents under `input` and does not use top_n.
      // Endpoint: https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          input: {
            query,
            documents: candidates,
          },
        },
      };
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: candidates.map((text) => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents: candidates,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents: candidates,
          top_n: topN,
        },
      };
  }
}

// ============================================================================
// Provider Response Parser
// ============================================================================

/** Parse provider-specific response into unified format */
export function parseRerankResponse(
  provider: RerankProvider,
  data: unknown,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index =
        typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };
  const objectData =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;

  switch (provider) {
    case "tei":
      return (
        parseItems(data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"]) ??
        parseItems(objectData?.data, ["score", "relevance_score"])
      );
    case "dashscope": {
      // DashScope: { output: { results: [{ index, relevance_score }] } }
      const output = objectData?.output as Record<string, unknown> | undefined;
      if (output) {
        return parseItems(output.results, ["relevance_score", "score"]);
      }
      // Fallback: try top-level results in case API format changes
      return parseItems(objectData?.results, ["relevance_score", "score"]);
    }
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(objectData?.data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(objectData?.data, ["relevance_score", "score"]) ??
        parseItems(objectData?.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(objectData?.results, ["relevance_score", "score"]) ??
        parseItems(objectData?.data, ["relevance_score", "score"])
      );
    }
  }
}

// ============================================================================
// Preservation Floor
// ============================================================================

export function getRerankPreservationFloor(result: RetrievalResult, unreturned: boolean): number {
  const bm25Score = result.sources.bm25?.score ?? 0;

  // Exact lexical hits (IDs, env vars, ticket numbers) should not disappear
  // just because a reranker under-scores symbolic or mixed-language queries.
  if (bm25Score >= 0.75) {
    return result.score * (unreturned ? 1.0 : 0.95);
  }
  if (bm25Score >= 0.6) {
    return result.score * (unreturned ? 0.95 : 0.9);
  }
  return result.score * (unreturned ? 0.8 : 0.5);
}

// ============================================================================
// Main Rerank Function
// ============================================================================

export async function rerankResults(
  query: string,
  queryVector: number[],
  results: RetrievalResult[],
  config: Pick<RetrievalConfig, "rerank" | "rerankProvider" | "rerankApiKey" | "rerankModel" | "rerankEndpoint" | "rerankTimeoutMs" | "vectorWeight" | "bm25Weight">,
  hasIds: (ids: string[]) => Promise<Set<string>>,
  logger: Pick<Logger, "debug" | "warn">,
  signal?: AbortSignal,
): Promise<RetrievalResult[]> {
  if (results.length === 0) {
    return results;
  }

  // Try cross-encoder rerank via configured provider API
  const provider = config.rerankProvider || "jina";
  const hasApiKey = !!config.rerankApiKey;

  if (config.rerank === "cross-encoder" && hasApiKey && config.rerankModel && config.rerankEndpoint) {
    try {
      const model = config.rerankModel;
      const endpoint = config.rerankEndpoint;
      const documents = results.map((r) => r.entry.text);

      // Build provider-specific request
      const { headers, body } = buildRerankRequest(
        provider,
        config.rerankApiKey || "",
        model,
        query,
        documents,
        results.length,
      );

      // Timeout: configurable via rerankTimeoutMs (default: 5000ms)
      // Also propagate external abort signal (e.g. auto-recall timeout).
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.rerankTimeoutMs ?? 5000);
      let unsubscribe: (() => void) | undefined;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeout);
          throw new DOMException("Rerank aborted (signal already aborted)", "AbortError");
        }
        const handler = () => { controller.abort(); clearTimeout(timeout); };
        signal.addEventListener("abort", handler, { once: true });
        unsubscribe = () => signal.removeEventListener("abort", handler);
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        unsubscribe?.();
      }

      if (response.ok) {
        const data: unknown = await response.json();

        // Parse provider-specific response into unified format
        const parsed = parseRerankResponse(provider, data);

        if (!parsed) {
          logger.warn(
            "Rerank API: invalid response shape, falling back to cosine",
          );
        } else {
          // Build a Set of returned indices to identify unreturned candidates
          const returnedIndices = new Set(parsed.map((r) => r.index));

          const reranked = parsed
            .filter((item) => item.index >= 0 && item.index < results.length)
            .map((item) => {
              const original = results[item.index];
              const floor = getRerankPreservationFloor(original, false);
              // Blend: 60% cross-encoder score + 40% original fused score
              const blendedScore = clamp01WithFloor(
                item.score * 0.6 + original.score * 0.4,
                floor,
              );
              return {
                ...original,
                score: blendedScore,
                sources: {
                  ...original.sources,
                  reranked: { score: item.score },
                },
              };
            });

          // Keep unreturned candidates with their original scores (slightly penalized)
          const unreturned = results
            .filter((_, idx) => !returnedIndices.has(idx))
            .map(r => ({
              ...r,
              score: clamp01WithFloor(
                r.score * 0.8,
                getRerankPreservationFloor(r, true),
              ),
            }));

          return [...reranked, ...unreturned].sort(
            (a, b) => b.score - a.score,
          );
        }
      } else {
        const errText = await response.text().catch(() => "");
        logger.warn(
          `Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Distinguish between external signal abort (e.g. auto-recall timeout)
        // and the rerank's own timeout by checking if the external signal was
        // already aborted when the error occurred.
        const wasExternalAbort = signal?.aborted === true;
        if (wasExternalAbort) {
          // Auto-recall timeouts intentionally abort in-flight rerank calls.
          // Retrieval falls back to cosine, so avoid noisy startup/runtime logs.
        } else {
          logger.warn(`Rerank API timed out (${config.rerankTimeoutMs ?? 5000}ms), falling back to cosine`);
        }
      } else {
        logger.warn("Rerank API failed, falling back to cosine:", error);
      }
    }
  }

  // Fallback: lightweight cosine similarity rerank
  try {
    const reranked = results.map((result) => {
      const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
      const combinedScore = result.score * 0.7 + cosineScore * 0.3;

      return {
        ...result,
        score: clamp01(combinedScore, result.score),
        sources: {
          ...result.sources,
          reranked: { score: cosineScore },
        },
      };
    });

    return reranked.sort((a, b) => b.score - a.score);
  } catch (error) {
    logger.warn("Reranking failed, returning original results:", error);
    return results;
  }
}
