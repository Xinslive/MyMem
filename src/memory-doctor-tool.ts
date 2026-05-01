import { Type } from "@sinclair/typebox";
import { resolveScopeFilter, parseAgentIdFromSessionKey, type MemoryScopeManager } from "./scopes.js";

interface OpenClawPluginApiLike {
  registerTool(definition: (toolCtx: unknown) => Record<string, unknown>, options?: { name: string }): void;
}

interface StoreLike {
  hasFtsSupport: boolean;
  count(): Promise<number>;
  getIndexStatus?(): Promise<{
    totalRows: number;
    totalIndices: number;
    names: string[];
    available: {
      fts: boolean;
      vector: boolean;
      scalar: string[];
    };
    exhaustiveVectorSearch: boolean;
    missingRecommendedScalars: string[];
    vectorIndexPending: boolean;
  }>;
  stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }>;
}

interface RetrieverLike {
  getConfig(): {
    mode: string;
    rerank: string;
    candidatePoolSize?: number;
    minScore?: number;
    hardMinScore?: number;
    rerankEndpoint?: string;
    rerankApiKey?: string;
    rerankProvider?: string;
    rerankModel?: string;
  };
  test(query?: string): Promise<{ success: boolean; mode: string; hasFtsSupport: boolean; error?: string }>;
  getStatsCollector?(): {
    count: number;
    getStats(): {
      totalQueries: number;
      zeroResultQueries: number;
      avgLatencyMs: number;
      p95LatencyMs: number;
      avgResultCount: number;
      rerankUsed: number;
      noiseFiltered: number;
      queriesBySource: Record<string, number>;
      topDropStages: { name: string; totalDropped: number }[];
    };
  } | null;
}

interface EmbedderLike {
  test(): Promise<{ success: boolean; error?: string; dimensions?: number }>;
}

interface DoctorToolContext {
  retriever: RetrieverLike;
  store: StoreLike;
  scopeManager: MemoryScopeManager;
  embedder: EmbedderLike;
  agentId?: string;
  telemetry?: {
    enabled: boolean;
    dir: string;
    filePaths: {
      retrieval: string;
      extraction: string;
    };
    getPersistentSummary(limit?: number): Promise<{
      retrieval: {
        totalQueries: number;
        zeroResultQueries: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
      } | null;
      extraction: {
        totalRuns: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
        totalCreated: number;
        totalMerged: number;
        totalSkipped: number;
        totalRejected: number;
      } | null;
    }>;
  } | null;
}

function resolveRuntimeAgentId(staticAgentId: string | undefined, runtimeCtx: unknown): string {
  if (!runtimeCtx || typeof runtimeCtx !== "object") return staticAgentId?.trim() || "main";
  const ctx = runtimeCtx as Record<string, unknown>;
  const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  return ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId || "main";
}

export function registerMemoryDoctorTool(api: OpenClawPluginApiLike, context: DoctorToolContext) {
  api.registerTool(
    (toolCtx) => {
      const staticAgentId = resolveRuntimeAgentId(context.agentId, toolCtx);
      return {
        name: "mymem_doctor",
        label: "Memory Doctor",
        description:
          "Run read-only diagnostics for storage, embedding, retrieval, scopes, and optional rerank configuration.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Optional retrieval probe query (default: test query)" })),
          testEmbedding: Type.Optional(Type.Boolean({ description: "When true, call the embedding provider with a probe text." })),
        }),
        async execute(_toolCallId: unknown, params: unknown, _signal: unknown, _onUpdate: unknown, runtimeCtx: unknown) {
          const { query, testEmbedding } = params as { query?: string; testEmbedding?: boolean };
          const agentId = resolveRuntimeAgentId(staticAgentId, runtimeCtx);
          const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message: string; details?: unknown }> = [];

          const addCheck = (
            name: string,
            status: "ok" | "warn" | "fail",
            message: string,
            details?: unknown,
          ) => checks.push({ name, status, message, details });

          let scopeFilter: string[] = [];
          try {
            scopeFilter = resolveScopeFilter(context.scopeManager, agentId) ?? [];
            addCheck("scopes", scopeFilter.length > 0 ? "ok" : "warn", `agent=${agentId}, scopes=${scopeFilter.join(", ") || "(none)"}`);
          } catch (error) {
            addCheck("scopes", "fail", error instanceof Error ? error.message : String(error));
          }

          try {
            const total = await context.store.count();
            const scopedStats = await context.store.stats(scopeFilter.length > 0 ? scopeFilter : undefined);
            addCheck("storage", "ok", `store readable; total=${total}, scoped=${scopedStats.totalCount}`, {
              hasFtsSupport: context.store.hasFtsSupport,
              scopeCounts: scopedStats.scopeCounts,
              categoryCounts: scopedStats.categoryCounts,
            });
          } catch (error) {
            addCheck("storage", "fail", error instanceof Error ? error.message : String(error));
          }

          if (typeof context.store.getIndexStatus === "function") {
            try {
              const indexStatus = await context.store.getIndexStatus();
              addCheck(
                "indices",
                indexStatus.exhaustiveVectorSearch || indexStatus.missingRecommendedScalars.length > 0 ? "warn" : "ok",
                `fts=${indexStatus.available.fts ? "yes" : "no"}, vector=${indexStatus.available.vector ? "yes" : "no"}, scalar=${indexStatus.available.scalar.join(", ") || "(none)"}`,
                indexStatus,
              );
            } catch (error) {
              addCheck("indices", "warn", error instanceof Error ? error.message : String(error));
            }
          }

          const retrievalConfig = context.retriever.getConfig();
          addCheck(
            "retrieval_config",
            retrievalConfig.mode === "hybrid" && !context.store.hasFtsSupport ? "warn" : "ok",
            `mode=${retrievalConfig.mode}, rerank=${retrievalConfig.rerank}, fts=${context.store.hasFtsSupport ? "yes" : "no"}`,
            {
              mode: retrievalConfig.mode,
              rerank: retrievalConfig.rerank,
              candidatePoolSize: retrievalConfig.candidatePoolSize,
              minScore: retrievalConfig.minScore,
              hardMinScore: retrievalConfig.hardMinScore,
            },
          );

          if (retrievalConfig.rerank !== "none") {
            const hasRerankEndpoint = typeof retrievalConfig.rerankEndpoint === "string" && retrievalConfig.rerankEndpoint.length > 0;
            const hasRerankKey = typeof retrievalConfig.rerankApiKey === "string" && retrievalConfig.rerankApiKey.length > 0;
            addCheck(
              "rerank_config",
              hasRerankEndpoint || hasRerankKey ? "ok" : "warn",
              hasRerankEndpoint || hasRerankKey
                ? `rerank configured (${retrievalConfig.rerankProvider || "default provider"})`
                : "rerank is enabled but no endpoint/api key is configured",
              {
                provider: retrievalConfig.rerankProvider,
                endpointConfigured: hasRerankEndpoint,
                apiKeyConfigured: hasRerankKey,
                model: retrievalConfig.rerankModel,
              },
            );
          }

          try {
            const probe = await context.retriever.test(query?.trim() || "test query");
            addCheck("retrieval_probe", probe.success ? "ok" : "fail", probe.success ? "retrieval pipeline completed" : (probe.error || "retrieval failed"), probe);
          } catch (error) {
            addCheck("retrieval_probe", "fail", error instanceof Error ? error.message : String(error));
          }

          const statsCollector = context.retriever.getStatsCollector?.() ?? null;
          const retrievalStats = statsCollector && statsCollector.count > 0
            ? statsCollector.getStats()
            : null;
          if (!statsCollector) {
            addCheck("retrieval_quality", "warn", "retrieval telemetry collector is not enabled");
          } else if (!retrievalStats) {
            addCheck("retrieval_quality", "warn", "no retrieval telemetry recorded yet; run mymem_recall or auto-recall first");
          } else {
            const zeroRate = retrievalStats.totalQueries > 0
              ? retrievalStats.zeroResultQueries / retrievalStats.totalQueries
              : 0;
            const status = zeroRate >= 0.5 ? "warn" : "ok";
            addCheck(
              "retrieval_quality",
              status,
              `queries=${retrievalStats.totalQueries}, zero=${retrievalStats.zeroResultQueries}, avgLatency=${retrievalStats.avgLatencyMs}ms, p95=${retrievalStats.p95LatencyMs}ms`,
              {
                ...retrievalStats,
                zeroResultRate: Number(zeroRate.toFixed(3)),
              },
            );
          }

          if (context.telemetry?.enabled) {
            try {
              const persistent = await context.telemetry.getPersistentSummary();
              if (!persistent.retrieval && !persistent.extraction) {
                addCheck(
                  "telemetry_persistence",
                  "warn",
                  `enabled at ${context.telemetry.dir}, but no telemetry has been persisted yet`,
                  context.telemetry.filePaths,
                );
              } else {
                addCheck(
                  "telemetry_persistence",
                  "ok",
                  `enabled at ${context.telemetry.dir}`,
                  {
                    ...context.telemetry.filePaths,
                    retrieval: persistent.retrieval,
                    extraction: persistent.extraction,
                  },
                );
              }
            } catch (error) {
              addCheck("telemetry_persistence", "warn", error instanceof Error ? error.message : String(error));
            }
          }

          if (testEmbedding) {
            try {
              const probe = await context.embedder.test();
              addCheck("embedding_probe", probe.success ? "ok" : "fail", probe.success ? `embedding provider returned ${probe.dimensions} dimensions` : (probe.error || "embedding failed"), probe);
            } catch (error) {
              addCheck("embedding_probe", "fail", error instanceof Error ? error.message : String(error));
            }
          } else {
            addCheck("embedding_probe", "warn", "skipped; pass testEmbedding=true to call the provider");
          }

          const statusRank = { ok: 0, warn: 1, fail: 2 } as const;
          const overall = checks.reduce<"ok" | "warn" | "fail">(
            (current, check) => statusRank[check.status] > statusRank[current] ? check.status : current,
            "ok",
          );
          const suggestions: string[] = [];
          for (const check of checks) {
            if (check.name === "scopes" && check.status !== "ok") {
              suggestions.push("Check scopes.agentAccess/default scope so this agent can read expected memories.");
            }
            if (check.name === "retrieval_config" && check.status === "warn") {
              suggestions.push("Hybrid mode is configured without FTS; enable FTS or switch retrieval.mode to vector.");
            }
            if (check.name === "indices" && check.status === "warn") {
              suggestions.push("Build scalar/vector indexes to avoid fallback scans on larger memory sets.");
            }
            if (check.name === "rerank_config" && check.status === "warn") {
              suggestions.push("Configure rerankEndpoint/rerankApiKey or set rerank to none.");
            }
            if (check.name === "embedding_probe" && check.status === "fail") {
              suggestions.push("Verify embedding apiKey/baseURL/model and vector dimensions.");
            }
            if (check.name === "retrieval_probe" && check.status === "fail") {
              suggestions.push("Run mymem_debug with the same query to inspect stage drops and score thresholds.");
            }
            if (check.name === "retrieval_quality" && check.status === "warn") {
              suggestions.push("If zero-result queries are high, lower minScore/hardMinScore or inspect scope filters and memory categories.");
            }
          }

          const text = [
            `Memory Doctor: ${overall.toUpperCase()}`,
            ...checks.map((check) => `• [${check.status.toUpperCase()}] ${check.name}: ${check.message}`),
            ...(suggestions.length > 0 ? ["", "Suggestions:", ...Array.from(new Set(suggestions)).map((s) => `• ${s}`)] : []),
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: { status: overall, agentId, checks, suggestions: Array.from(new Set(suggestions)) },
          };
        },
      };
    },
    { name: "mymem_doctor" },
  );
}
