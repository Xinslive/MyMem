import type {
  MemoryRetriever,
  RetrievalContext,
  RetrievalDiagnostics,
  RetrievalResult,
} from "./retriever.js";
import type { RetrievalTrace, RetrievalStageResult } from "./retrieval-trace.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { clampInt } from "./utils.js";

type ExplainSource = Extract<RetrievalContext["source"], "manual" | "cli">;

export interface RetrievalExplanation {
  status: "matched" | "empty" | "degraded";
  summary: string;
  reasons: string[];
  suggestions: string[];
  topDropStage?: {
    name: string;
    dropped: number;
    inputCount: number;
    outputCount: number;
  };
}

export interface RetrievalExplainReport {
  text: string;
  details: {
    query: string;
    count: number;
    results: ReturnType<typeof serializeExplainResults>;
    trace: RetrievalTrace;
    diagnostics: RetrievalDiagnostics | null;
    explanation: RetrievalExplanation;
  };
}

export interface ExplainRetrievalOptions {
  query: string;
  limit?: number;
  scopeFilter?: string[];
  category?: string;
  source?: ExplainSource;
  hasFtsSupport?: boolean;
}

function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}...`;
}

function stageLabel(name: string): string {
  switch (name) {
    case "parallel_search":
      return "parallel vector/BM25 search";
    case "rrf_fusion":
      return "RRF fusion";
    case "min_score_filter":
      return "minScore filter";
    case "hard_cutoff":
      return "hardMinScore filter";
    case "noise_filter":
      return "noise filter";
    case "mmr_diversity":
      return "MMR diversity";
    case "length_normalization":
      return "length normalization";
    case "time_decay":
      return "time decay";
    case "decay_boost":
      return "decay boost";
    case "recency_composite":
      return "recency scoring";
    case "fallback_scoring":
      return "fallback scoring";
    default:
      return name;
  }
}

function droppedCount(stage: RetrievalStageResult): number {
  return Math.max(0, stage.inputCount - stage.outputCount);
}

function findTopDropStage(trace: RetrievalTrace): RetrievalExplanation["topDropStage"] {
  let best: RetrievalStageResult | null = null;
  for (const stage of trace.stages) {
    if (stage.inputCount <= 0) continue;
    if (!best || droppedCount(stage) > droppedCount(best)) best = stage;
  }
  if (!best || droppedCount(best) <= 0) return undefined;
  return {
    name: best.name,
    dropped: droppedCount(best),
    inputCount: best.inputCount,
    outputCount: best.outputCount,
  };
}

function firstAllDropStage(trace: RetrievalTrace): RetrievalStageResult | undefined {
  return trace.stages.find((stage) => stage.inputCount > 0 && stage.outputCount === 0);
}

function searchFoundNoCandidates(trace: RetrievalTrace): boolean {
  const searchStage = trace.stages.find((stage) =>
    stage.name === "parallel_search" ||
    stage.name === "bm25_search" ||
    stage.name === "vector_search"
  );
  return !searchStage || searchStage.outputCount === 0;
}

function serializeExplainResults(results: RetrievalResult[]) {
  return results.map((result) => ({
    id: result.entry.id,
    text: result.entry.text,
    category: getDisplayCategoryTag(result.entry),
    rawCategory: result.entry.category,
    scope: result.entry.scope,
    importance: result.entry.importance,
    score: result.score,
    confidence: result.confidence,
    sources: result.sources,
  }));
}

export function buildRetrievalExplanation(params: {
  results: RetrievalResult[];
  trace: RetrievalTrace;
  diagnostics: RetrievalDiagnostics | null;
  config: ReturnType<MemoryRetriever["getConfig"]>;
  hasFtsSupport?: boolean;
  scopeFilter?: string[];
  category?: string;
}): RetrievalExplanation {
  const { results, trace, diagnostics, config, hasFtsSupport, scopeFilter, category } = params;
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const topDropStage = findTopDropStage(trace);

  if (config.mode === "hybrid" && hasFtsSupport === false) {
    reasons.push("Hybrid retrieval is configured, but FTS is unavailable; BM25 may use lexical fallback behavior.");
    suggestions.push("Run mymem_doctor or rebuild the FTS index if keyword recall looks weak.");
  }

  if (diagnostics?.degraded) {
    reasons.push(`Retrieval degraded: ${diagnostics.degradedReason || "unknown reason"}.`);
  }

  if (scopeFilter && scopeFilter.length > 0) {
    reasons.push(`Searched scopes: ${scopeFilter.join(", ")}.`);
  }
  if (category) {
    reasons.push(`Applied category filter: ${category}.`);
  }

  if (results.length > 0) {
    if (topDropStage && topDropStage.dropped > 0) {
      reasons.push(
        `Largest candidate drop was ${stageLabel(topDropStage.name)} (${topDropStage.inputCount} -> ${topDropStage.outputCount}).`,
      );
    }
    return {
      status: diagnostics?.degraded ? "degraded" : "matched",
      summary: `Matched ${results.length} memory result${results.length === 1 ? "" : "s"}.`,
      reasons,
      suggestions,
      topDropStage,
    };
  }

  const allDropStage = firstAllDropStage(trace);
  if (diagnostics?.errorMessage) {
    reasons.push(`Retrieval failed at ${diagnostics.failureStage || "unknown stage"}: ${diagnostics.errorMessage}.`);
    suggestions.push("Inspect provider connectivity and rerun mymem_debug with the same query.");
  } else if (allDropStage?.name === "hard_cutoff") {
    reasons.push("Candidates were removed by the hardMinScore filter.");
    suggestions.push("Lower retrieval.hardMinScore or inspect candidate scores with mymem_debug.");
  } else if (allDropStage?.name === "min_score_filter") {
    reasons.push("Candidates were removed by the minScore filter before reranking.");
    suggestions.push("Lower retrieval.minScore or broaden the query.");
  } else if (allDropStage?.name === "noise_filter") {
    reasons.push("The noise filter removed all surviving candidates.");
    suggestions.push("Inspect the candidate text and noise-learning settings.");
  } else if (allDropStage?.name === "rerank") {
    reasons.push("Reranking removed all candidates.");
    suggestions.push("Check rerank configuration or try retrieval.rerank=none for comparison.");
  } else if (searchFoundNoCandidates(trace)) {
    reasons.push("Vector/BM25 search found no initial candidates.");
    suggestions.push("Check scope filters, category filters, and whether matching memories exist.");
  } else if (allDropStage) {
    reasons.push(`All candidates were removed during ${stageLabel(allDropStage.name)}.`);
  } else {
    reasons.push("No results survived the retrieval pipeline.");
  }

  if (topDropStage && topDropStage.dropped > 0 && !reasons.some((reason) => reason.includes(stageLabel(topDropStage.name)))) {
    reasons.push(
      `Largest candidate drop was ${stageLabel(topDropStage.name)} (${topDropStage.inputCount} -> ${topDropStage.outputCount}).`,
    );
  }

  return {
    status: diagnostics?.degraded ? "degraded" : "empty",
    summary: "No memories survived the retrieval pipeline.",
    reasons,
    suggestions,
    topDropStage,
  };
}

export function formatRetrievalExplainText(report: RetrievalExplainReport["details"]): string {
  const lines = [
    "Memory Explain:",
    `Query: ${report.query}`,
    `Diagnosis: ${report.explanation.summary}`,
  ];

  if (report.explanation.reasons.length > 0) {
    lines.push("", "Reasons:");
    for (const reason of report.explanation.reasons) lines.push(`- ${reason}`);
  }

  if (report.explanation.suggestions.length > 0) {
    lines.push("", "Suggestions:");
    for (const suggestion of report.explanation.suggestions) lines.push(`- ${suggestion}`);
  }

  lines.push("", "Stages:");
  if (report.trace.stages.length === 0) {
    lines.push("- No trace stages were recorded.");
  } else {
    for (const stage of report.trace.stages) {
      const scoreRange = stage.scoreRange
        ? ` score=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
        : "";
      const flow = stage.inputCount === 0
        ? `found ${stage.outputCount}`
        : `${stage.inputCount} -> ${stage.outputCount} (-${droppedCount(stage)})`;
      lines.push(`- ${stageLabel(stage.name)}: ${flow}, ${stage.durationMs}ms${scoreRange}`);
    }
  }

  if (report.results.length === 0) {
    lines.push("", "Results: none");
    return lines.join("\n");
  }

  lines.push("", `Results (${report.results.length}):`);
  for (const [index, result] of report.results.entries()) {
    lines.push(
      `${index + 1}. [${result.id}] [${result.category}:${result.scope}] ` +
      `${truncateText(normalizeInlineText(result.text), 140)} ` +
      `(score=${result.score.toFixed(3)})`,
    );
  }
  return lines.join("\n");
}

export async function explainMemoryRetrieval(
  retriever: Pick<MemoryRetriever, "retrieveWithTrace" | "getConfig" | "getLastDiagnostics">,
  options: ExplainRetrievalOptions,
): Promise<RetrievalExplainReport> {
  const safeLimit = clampInt(options.limit ?? 5, 1, 20);
  const { results, trace } = await retriever.retrieveWithTrace({
    query: options.query,
    limit: safeLimit,
    scopeFilter: options.scopeFilter,
    category: options.category,
    source: options.source ?? "manual",
  });
  const diagnostics = typeof retriever.getLastDiagnostics === "function"
    ? retriever.getLastDiagnostics()
    : null;
  const explanation = buildRetrievalExplanation({
    results,
    trace,
    diagnostics,
    config: retriever.getConfig(),
    hasFtsSupport: options.hasFtsSupport,
    scopeFilter: options.scopeFilter,
    category: options.category,
  });
  const details = {
    query: options.query,
    count: results.length,
    results: serializeExplainResults(results),
    trace,
    diagnostics,
    explanation,
  };
  return {
    text: formatRetrievalExplainText(details),
    details,
  };
}

export { serializeExplainResults };
