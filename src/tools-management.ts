/**
 * Agent Tool Definitions — Management Tools
 * Registration functions for memory_stats, memory_debug, memory_list,
 * memory_promote, memory_archive, memory_compact, and memory_explain_rank.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ToolContext,
  resolveToolContext,
  resolveRuntimeAgentId,
  resolveAgentId,
  memoryCategoryEnum,
  clamp01,
  normalizeInlineText,
  truncateText,
  fallbackToolLogger,
  retrieveWithRetry,
  sanitizeMemoryForSerialization,
  resolveMemoryId,
} from "./tools-shared.js";
import { clampInt } from "./utils.js";
import { resolveScopeFilter } from "./scopes.js";
import {
  parseSmartMetadata,
} from "./smart-metadata.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";

export function registerMemoryStatsTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_stats",
      label: "Memory Statistics",
      description: "Get statistics about memory usage, scopes, and categories.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: "Specific scope to get stats for (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { scope } = params as { scope?: string };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          const stats = await context.store.stats(scopeFilter);
          const scopeManagerStats = context.scopeManager.getStats();
          const retrievalConfig = context.retriever.getConfig();
          const indexStatus = typeof (context.store as any).getIndexStatus === "function"
            ? await (context.store as any).getIndexStatus()
            : null;
          const persistentSummary = context.telemetry
            ? await context.telemetry.getPersistentSummary()
            : { retrieval: null, extraction: null };

          const textLines = [
            `Memory Statistics:`,
            `\u2022 Total memories: ${stats.totalCount}`,
            `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
            `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
            `\u2022 FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
            ...(indexStatus
              ? [
                  `\u2022 Vector index: ${indexStatus.available.vector ? "Yes" : "No"}`,
                  `\u2022 Scalar indexes: ${indexStatus.available.scalar.join(", ") || "(none)"}`,
                ]
              : []),
            ``,
            `Memories by scope:`,
            ...Object.entries(stats.scopeCounts).map(
              ([s, count]) => `  \u2022 ${s}: ${count}`,
            ),
            ``,
            `Memories by category:`,
            ...Object.entries(stats.categoryCounts).map(
              ([c, count]) => `  \u2022 ${c}: ${count}`,
            ),
          ];

          // Include retrieval quality metrics if stats collector is available
          const statsCollector = context.retriever.getStatsCollector();
          let retrievalStats = undefined;
          if (statsCollector && statsCollector.count > 0) {
            retrievalStats = statsCollector.getStats();
            textLines.push(
              ``,
              `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`,
              `  \u2022 Zero-result queries: ${retrievalStats.zeroResultQueries}`,
              `  \u2022 Avg latency: ${retrievalStats.avgLatencyMs}ms`,
              `  \u2022 P95 latency: ${retrievalStats.p95LatencyMs}ms`,
              `  \u2022 Avg result count: ${retrievalStats.avgResultCount}`,
              `  \u2022 Rerank used: ${retrievalStats.rerankUsed}`,
              `  \u2022 Noise filtered: ${retrievalStats.noiseFiltered}`,
            );
            if (retrievalStats.topDropStages.length > 0) {
              textLines.push(`  Top drop stages:`);
              for (const ds of retrievalStats.topDropStages) {
                textLines.push(`    \u2022 ${ds.name}: ${ds.totalDropped} dropped`);
              }
            }
          }

          if (persistentSummary.retrieval) {
            const persisted = persistentSummary.retrieval;
            textLines.push(
              ``,
              `Persistent Retrieval Telemetry:`,
              `  \u2022 Queries: ${persisted.totalQueries}`,
              `  \u2022 Zero-result queries: ${persisted.zeroResultQueries}`,
              `  \u2022 Avg latency: ${persisted.avgLatencyMs}ms`,
              `  \u2022 P95 latency: ${persisted.p95LatencyMs}ms`,
            );
          }

          if (persistentSummary.extraction) {
            const extraction = persistentSummary.extraction;
            textLines.push(
              ``,
              `Persistent Extraction Telemetry:`,
              `  \u2022 Runs: ${extraction.totalRuns}`,
              `  \u2022 Avg latency: ${extraction.avgLatencyMs}ms`,
              `  \u2022 P95 latency: ${extraction.p95LatencyMs}ms`,
              `  \u2022 Created / merged / skipped: ${extraction.totalCreated} / ${extraction.totalMerged} / ${extraction.totalSkipped}`,
            );
          }

          const text = textLines.join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              stats,
              scopeManagerStats,
              retrievalConfig: {
                ...retrievalConfig,
                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
              },
              hasFtsSupport: context.store.hasFtsSupport,
              retrievalStats,
              indexStatus,
              telemetry: context.telemetry
                ? {
                    enabled: context.telemetry.enabled,
                    dir: context.telemetry.dir,
                    filePaths: context.telemetry.filePaths,
                    persistentSummary,
                  }
                : null,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "stats_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_stats" },
  );
}

export function registerMemoryDebugTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_debug",
        label: "Memory Debug",
        description:
          "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query to debug" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results to return (default: 5, max: 20)" }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Specific memory scope to search in (optional)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5, scope } = params as {
            query: string; limit?: number; scope?: string;
          };
          try {
            const safeLimit = clampInt(limit, 1, 20);
            let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
            if (scope) {
              if (context.scopeManager.isAccessible(scope, agentId)) {
                scopeFilter = [scope];
              } else {
                return {
                  content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                  details: { error: "scope_access_denied", requestedScope: scope },
                };
              }
            }

            const { results, trace } = await context.retriever.retrieveWithTrace({
              query, limit: safeLimit, scopeFilter, source: "manual",
            });

            const traceLines: string[] = [
              `Retrieval Debug Trace:`,
              `  Mode: ${trace.mode}`,
              `  Total: ${trace.totalMs}ms`,
              `  Stages:`,
            ];
            for (const stage of trace.stages) {
              const dropped = Math.max(0, stage.inputCount - stage.outputCount);
              const scoreStr = stage.scoreRange
                ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
                : "";
              // For search stages (input=0), show "found N" instead of "dropped -N"
              const dropStr = stage.inputCount === 0
                ? `found ${stage.outputCount}`
                : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
              traceLines.push(
                `    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`,
              );
              if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
                traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
              } else if (stage.droppedIds.length > 3) {
                traceLines.push(
                  `      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`,
                );
              }
            }

            if (results.length === 0) {
              traceLines.push(``, `No results survived the pipeline.`);
              return {
                content: [{ type: "text", text: traceLines.join("\n") }],
                details: { count: 0, query, trace },
              };
            }

            const resultLines = results.map((r, i) => {
              const sources: string[] = [];
              if (r.sources.vector) sources.push("vector");
              if (r.sources.bm25) sources.push("BM25");
              if (r.sources.reranked) sources.push("reranked");
              const categoryTag = getDisplayCategoryTag(r.entry);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
            });

            const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
            return {
              content: [{ type: "text", text }],
              details: {
                count: results.length,
                memories: sanitizeMemoryForSerialization(results),
                query,
                trace,
              },
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Memory debug failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: { error: "debug_failed", message: String(error) },
            };
          }
        },
      };
    },
    { name: "memory_debug" },
  );
}

export function registerMemoryListTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_list",
      label: "Memory List",
      description:
        "List recent memories with optional filtering by scope and category.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Max memories to list (default: 10, max: 50)",
          }),
        ),
        scope: Type.Optional(
          Type.String({ description: "Filter by specific scope (optional)" }),
        ),
        category: Type.Optional(memoryCategoryEnum()),
        offset: Type.Optional(
          Type.Number({
            description: "Number of memories to skip (default: 0)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const {
          limit = 10,
          scope,
          category,
          offset = 0,
        } = params as {
          limit?: number;
          scope?: string;
          category?: string;
          offset?: number;
        };

        try {
          const safeLimit = clampInt(limit, 1, 50);
          const safeOffset = clampInt(offset, 0, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);

          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          const entries = await context.store.list(
            scopeFilter,
            category,
            safeLimit,
            safeOffset,
          );

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: {
                count: 0,
                filters: {
                  scope,
                  category,
                  limit: safeLimit,
                  offset: safeOffset,
                },
              },
            };
          }

          const text = entries
            .map((entry, i) => {
              const date = new Date(entry.timestamp)
                .toISOString()
                .split("T")[0];
              const categoryTag = getDisplayCategoryTag(entry);
              return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Recent memories (showing ${entries.length}):\n\n${text}`,
              },
            ],
            details: {
              count: entries.length,
              memories: entries.map((e) => ({
                id: e.id,
                text: e.text,
                category: getDisplayCategoryTag(e),
                rawCategory: e.category,
                scope: e.scope,
                importance: e.importance,
                timestamp: e.timestamp,
              })),
              filters: {
                scope,
                category,
                limit: safeLimit,
                offset: safeOffset,
              },
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "list_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_list" },
  );
}

export function registerMemoryPromoteTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_promote",
        label: "Memory Promote",
        description:
          "Promote a memory into confirmed/durable governance state so it can participate in conservative auto-recall.",
        parameters: Type.Object({
          memoryId: Type.Optional(
            Type.String({ description: "Memory id (UUID/prefix). Optional when query is provided." }),
          ),
          query: Type.Optional(
            Type.String({ description: "Search query to locate a memory when memoryId is omitted." }),
          ),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          state: Type.Optional(Type.Union([
            Type.Literal("pending"),
            Type.Literal("confirmed"),
            Type.Literal("archived"),
          ])),
          layer: Type.Optional(Type.Union([
            Type.Literal("durable"),
            Type.Literal("working"),
            Type.Literal("reflection"),
            Type.Literal("archive"),
          ])),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const {
            memoryId,
            query,
            scope,
            state = "confirmed",
            layer = "durable",
          } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            state?: "pending" | "confirmed" | "archived";
            layer?: "durable" | "working" | "reflection" | "archive";
          };

          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter ?? [],
          );
          if (!resolved.ok) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const before = await runtimeContext.store.getById(resolved.id, scopeFilter);
          if (!before) {
            return {
              content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
              details: { error: "not_found", id: resolved.id },
            };
          }

          const now = Date.now();
          const updated = await runtimeContext.store.patchMetadata(
            resolved.id,
            {
              source: "manual",
              state,
              memory_layer: layer,
              last_confirmed_use_at: state === "confirmed" ? now : undefined,
              bad_recall_count: 0,
              suppressed_until_turn: 0,
            },
            scopeFilter,
          );
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "promote_failed", id: resolved.id },
            };
          }

          return {
            content: [{
              type: "text",
              text: `Promoted memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${layer}.`,
            }],
            details: {
              action: "promoted",
              id: resolved.id,
              state,
              layer,
            },
          };
        },
      };
    },
    { name: "memory_promote" },
  );
}

export function registerMemoryArchiveTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_archive",
        label: "Memory Archive",
        description:
          "Archive a memory to remove it from default auto-recall while preserving history.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
          query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          reason: Type.Optional(Type.String({ description: "Archive reason for audit trail." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { memoryId, query, scope, reason = "manual_archive" } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            reason?: string;
          };
          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter ?? [],
          );
          if (!resolved.ok) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const patch = {
            state: "archived" as const,
            memory_layer: "archive" as const,
            archive_reason: reason,
            archived_at: Date.now(),
          };
          const updated = await runtimeContext.store.patchMetadata(resolved.id, patch, scopeFilter);
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "archive_failed", id: resolved.id },
            };
          }

          return {
            content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
            details: { action: "archived", id: resolved.id, reason },
          };
        },
      };
    },
    { name: "memory_archive" },
  );
}

export function registerMemoryCompactTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_compact",
        label: "Memory Compact",
        description:
          "Compact duplicate low-value memories by archiving redundant entries and linking them to a canonical memory.",
        parameters: Type.Object({
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only (default true)." })),
          limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { scope, dryRun = true, limit = 200 } = params as {
            scope?: string;
            dryRun?: boolean;
            limit?: number;
          };

          const safeLimit = clampInt(limit, 20, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const entries = await runtimeContext.store.list(scopeFilter, undefined, safeLimit, 0);
          const canonicalByKey = new Map<string, typeof entries[number]>();
          const duplicates: Array<{ duplicateId: string; canonicalId: string; key: string }> = [];

          for (const entry of entries) {
            const meta = parseSmartMetadata(entry.metadata, entry);
            if (meta.state === "archived") continue;
            const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
            const existing = canonicalByKey.get(key);
            if (!existing) {
              canonicalByKey.set(key, entry);
              continue;
            }
            const keep =
              existing.timestamp >= entry.timestamp ? existing : entry;
            const drop =
              keep.id === existing.id ? entry : existing;
            canonicalByKey.set(key, keep);
            duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
          }

          let archivedCount = 0;
          if (!dryRun) {
            for (const item of duplicates) {
              await runtimeContext.store.patchMetadata(
                item.duplicateId,
                {
                  state: "archived",
                  memory_layer: "archive",
                  canonical_id: item.canonicalId,
                  archive_reason: "compact_duplicate",
                  archived_at: Date.now(),
                },
                scopeFilter,
              );
              archivedCount++;
            }
          }

          return {
            content: [{
              type: "text",
              text: dryRun
                ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
                : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
            }],
            details: {
              action: dryRun ? "compact_preview" : "compact_applied",
              scanned: entries.length,
              duplicates: duplicates.length,
              archived: archivedCount,
              sample: duplicates.slice(0, 20),
            },
          };
        },
      };
    },
    { name: "memory_compact" },
  );
}

export function registerMemoryExplainRankTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_explain_rank",
        label: "Memory Explain Rank",
        description:
          "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
        parameters: Type.Object({
          query: Type.String({ description: "Query used for ranking analysis." }),
          limit: Type.Optional(Type.Number({ description: "How many items to explain (default 5)." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope } = params as {
            query: string;
            limit?: number;
            scope?: string;
          };

          const safeLimit = clampInt(limit, 1, 20);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const results = await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
            source: "manual",
          }, () => runtimeContext.store.count());
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { action: "empty", query, scopeFilter },
            };
          }

          const lines = results.map((r, idx) => {
            const meta = parseSmartMetadata(r.entry.metadata, r.entry);
            const sourceBreakdown = [];
            if (r.sources.vector) sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
            if (r.sources.bm25) sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
            if (r.sources.reranked) sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
            return [
              `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
              `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
              `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
              `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
            ].join("\n");
          });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              action: "explain_rank",
              query,
              count: results.length,
              results: sanitizeMemoryForSerialization(results),
            },
          };
        },
      };
    },
    { name: "memory_explain_rank" },
  );
}
