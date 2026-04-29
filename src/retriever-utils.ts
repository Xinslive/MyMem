/**
 * Utility functions for the retrieval system.
 */

import type { RetrievalDiagnostics } from "./retriever-types.js";

// ============================================================================
// Numeric Helpers
// ============================================================================

export function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

export function clamp01WithFloor(value: number, floor: number): number {
  const safeFloor = clamp01(floor, 0);
  return Math.max(safeFloor, clamp01(value, safeFloor));
}

// ============================================================================
// Error Helpers
// ============================================================================

import type { TaggedRetrievalError } from "./retriever-types.js";

export function attachFailureStage(
  error: unknown,
  stage: NonNullable<RetrievalDiagnostics["failureStage"]>,
): TaggedRetrievalError {
  const tagged: TaggedRetrievalError =
    error instanceof Error ? (error as TaggedRetrievalError) : new Error(String(error));
  tagged.retrievalFailureStage = stage;
  return tagged;
}

export function extractFailureStage(
  error: unknown,
): RetrievalDiagnostics["failureStage"] | undefined {
  return error instanceof Error
    ? (error as TaggedRetrievalError).retrievalFailureStage
    : undefined;
}

// ============================================================================
// Abort Helpers
// ============================================================================

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason || "Operation aborted"), "AbortError");
}

export async function resolveUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ============================================================================
// Diagnostics Helpers
// ============================================================================

export function buildDropSummary(
  diagnostics: RetrievalDiagnostics,
): RetrievalDiagnostics["dropSummary"] {
  const stageDrops = [
    {
      order: 0,
      stage: "minScore" as const,
      before:
        diagnostics.mode === "vector"
          ? diagnostics.vectorResultCount
          : diagnostics.fusedResultCount,
      after: diagnostics.stageCounts.afterMinScore,
    },
    {
      order: 1,
      stage: "rerankWindow" as const,
      before: diagnostics.stageCounts.afterMinScore,
      after: diagnostics.stageCounts.rerankInput,
    },
    {
      order: 2,
      stage: "rerank" as const,
      before: diagnostics.stageCounts.rerankInput,
      after: diagnostics.stageCounts.afterRerank,
    },
    {
      order: 3,
      stage: "recencyBoost" as const,
      before: diagnostics.stageCounts.afterRerank,
      after: diagnostics.stageCounts.afterRecency,
    },
    {
      order: 4,
      stage: "importanceWeight" as const,
      before: diagnostics.stageCounts.afterRecency,
      after: diagnostics.stageCounts.afterImportance,
    },
    {
      order: 5,
      stage: "lengthNorm" as const,
      before: diagnostics.stageCounts.afterImportance,
      after: diagnostics.stageCounts.afterLengthNorm,
    },
    {
      order: 6,
      stage: "hardMinScore" as const,
      before: diagnostics.stageCounts.afterLengthNorm,
      after: diagnostics.stageCounts.afterHardMinScore,
    },
    {
      order: 7,
      stage: "timeDecay" as const,
      before: diagnostics.stageCounts.afterHardMinScore,
      after: diagnostics.stageCounts.afterTimeDecay,
    },
    {
      order: 8,
      stage: "noiseFilter" as const,
      before: diagnostics.stageCounts.afterTimeDecay,
      after: diagnostics.stageCounts.afterNoiseFilter,
    },
    {
      order: 9,
      stage: "diversity" as const,
      before: diagnostics.stageCounts.afterNoiseFilter,
      after: diagnostics.stageCounts.afterDiversity,
    },
    {
      order: 10,
      stage: "limit" as const,
      before: diagnostics.stageCounts.afterDiversity,
      after: diagnostics.finalResultCount,
    },
  ];

  return stageDrops
    .map(({ order, stage, before, after }) => ({
      order,
      stage,
      before,
      after,
      dropped: Math.max(0, before - after),
    }))
    .filter((drop) => drop.dropped > 0)
    .sort((a, b) => b.dropped - a.dropped || a.order - b.order)
    .map(({ order: _order, ...drop }) => drop);
}
