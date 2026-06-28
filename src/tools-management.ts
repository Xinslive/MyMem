/**
 * Agent Tool Definitions — Management Tools
 * Registration functions for mymem_stats, mymem_debug, mymem_explain,
 * mymem_list, mymem_promote, mymem_archive, mymem_compact, and mymem_explain_rank.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ToolContext,
  resolveToolContext,
  resolveRuntimeAgentId,
  memoryCategoryEnum,
  normalizeInlineText,
  truncateText,
  retrieveWithRetry,
  sanitizeMemoryForSerialization,
  resolveMemoryId,
  filterEntriesByMemoryCategory,
  toStrictMemoryCategory,
} from "./tools-shared.js";
import { clampInt } from "./utils.js";
import { resolveScopeFilter } from "./scopes.js";
import {
  parseSmartMetadata,
} from "./smart-metadata.js";
import { getSmartDisplayCategoryTag } from "./reflection-metadata.js";
import { explainMemoryRetrieval } from "./retrieval-explain.js";
import type { StoreIndexStatus } from "./store.js";
import { buildPositiveUtilityMetadataPatch } from "./learning-memory.js";

type StoreWithOptionalIndexStatus = ToolContext["store"] & {
  getIndexStatus?: () => Promise<StoreIndexStatus>;
};

export function registerMemoryStatsTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "mymem_stats",
      label: "Memory Statistics",
      description: "Inspect memory inventory and health signals when you need a quick overview of counts, scopes, categories, lifecycle state, retrieval quality, or whether memory is growing/noisy.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: "Specific scope to inspect when diagnosing a project/agent-specific memory set.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { scope } = params as { scope?: string };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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

          const stats = await runtimeContext.store.stats(scopeFilter);
          const scopeManagerStats = runtimeContext.scopeManager.getStats();
          const retrievalConfig = runtimeContext.retriever.getConfig();
          const storeWithIndexStatus = runtimeContext.store as StoreWithOptionalIndexStatus;
          const indexStatus = typeof storeWithIndexStatus.getIndexStatus === "function"
            ? await storeWithIndexStatus.getIndexStatus()
            : null;
          const persistentSummary = context.telemetry
            ? await context.telemetry.getPersistentSummary()
            : { retrieval: null, extraction: null };

          const textLines = [
            `Memory Statistics:`,
            `\u2022 Total memories: ${stats.totalCount}`,
            `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
            `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
            `\u2022 FTS support: ${runtimeContext.store.hasFtsSupport ? "Yes" : "No"}`,
            ...(indexStatus
              ? [
                  `\u2022 Vector index: ${indexStatus.available.vector ? "Yes" : "No"}`,
                  `\u2022 Scalar indexes: ${indexStatus.available.scalar.join(", ") || "(none)"}`,
                ]
              : []),
            ``,
            `Recent Activity:`,
            `  \u2022 Last 24 hours: ${stats.recentActivity.last24h} new`,
            `  \u2022 Last 7 days: ${stats.recentActivity.last7d} new`,
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
            ``,
            `Lifecycle distribution:`,
            ...Object.entries(stats.tierDistribution).map(
              ([t, count]) => `  \u2022 ${t}: ${count}`,
            ),
            ``,
            `Health signals:`,
            `  \u2022 Bad recall count > 0: ${stats.healthSignals.badRecall}`,
            `  \u2022 Currently suppressed: ${stats.healthSignals.suppressed}`,
            `  \u2022 Low confidence (<0.4): ${stats.healthSignals.lowConfidence}`,
          ];

          // Include retrieval quality metrics if stats collector is available
          const statsCollector = runtimeContext.retriever.getStatsCollector();
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
              hasFtsSupport: runtimeContext.store.hasFtsSupport,
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
    { name: "mymem_stats" },
  );
}

export function registerMemoryDebugTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "mymem_debug",
        label: "Memory Debug",
        description:
          "Debug a specific bad or empty auto-recall by running the same retrieval source with trace details: stage drops, score ranges, selected sources, and timing.",
        parameters: Type.Object({
          query: Type.String({ description: "Problem query that returned poor, surprising, or zero memory results." }),
          limit: Type.Optional(
            Type.Number({ description: "Max results to return (default: 5, max: 20)" }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Specific scope to test when scope filtering may explain the recall issue." }),
          ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope } = params as {
            query: string; limit?: number; scope?: string;
          };
          try {
            const safeLimit = clampInt(limit, 1, 20);
            const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
            let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
            if (scope) {
              if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                scopeFilter = [scope];
              } else {
                return {
                  content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                  details: { error: "scope_access_denied", requestedScope: scope },
                };
              }
            }

            const { results, trace } = await runtimeContext.retriever.retrieveWithTrace({
              query, limit: safeLimit, scopeFilter, source: "auto-recall",
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
              const categoryTag = getSmartDisplayCategoryTag(r.entry);
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
    { name: "mymem_debug" },
  );
}

export function registerMemoryExplainTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "mymem_explain",
        label: "Memory Explain",
        description:
          "Explain why a recall query matched certain memories or returned no results, with likely corrective actions. Prefer this for human-readable diagnosis; use mymem_debug when you need raw pipeline trace.",
        parameters: Type.Object({
          query: Type.String({ description: "Recall query whose ranking, empty result, or mismatch needs explanation." }),
          limit: Type.Optional(
            Type.Number({ description: "Max results to return (default: 5, max: 20)" }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Specific scope to explain when the issue may be scope-related." }),
          ),
          category: Type.Optional(memoryCategoryEnum()),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope, category } = params as {
            query: string;
            limit?: number;
            scope?: string;
            category?: string;
          };
          try {
            const safeLimit = clampInt(limit, 1, 20);
            const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
            let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
            if (scope) {
              if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                scopeFilter = [scope];
              } else {
                return {
                  content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                  details: { error: "scope_access_denied", requestedScope: scope, query },
                };
              }
            }

            if (category && !toStrictMemoryCategory(category)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid memory category: ${category}. Use one of: profile, preferences, entities, events, cases, patterns.`,
                  },
                ],
                details: { error: "invalid_category", category },
              };
            }

            const report = await explainMemoryRetrieval(runtimeContext.retriever, {
              query,
              limit: safeLimit,
              scopeFilter,
              category,
              source: "auto-recall",
              hasFtsSupport: runtimeContext.store.hasFtsSupport,
            });

            return {
              content: [{ type: "text", text: report.text }],
              details: report.details,
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Memory explain failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: { error: "explain_failed", query, message: String(error) },
            };
          }
        },
      };
    },
    { name: "mymem_explain" },
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
        name: "mymem_list",
      label: "Memory List",
      description:
        "List recent stored memories for audit, cleanup, or to find an ID before update/archive/forget. Use when you need inventory, not semantic search; use mymem_recall for relevance-ranked lookup.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Max memories to list (default: 10, max: 50)",
          }),
        ),
        scope: Type.Optional(
          Type.String({ description: "Filter by specific scope when auditing a project/agent memory set." }),
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
          if (category && !toStrictMemoryCategory(category)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid memory category: ${category}. Use one of: profile, preferences, entities, events, cases, patterns.`,
                },
              ],
              details: { error: "invalid_category", category },
            };
          }
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);

          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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

          const entries = await runtimeContext.store.list(
            scopeFilter,
            undefined,
            category ? Math.min(200, safeLimit + safeOffset) : safeLimit,
            category ? 0 : safeOffset,
          );
          const filteredEntries = filterEntriesByMemoryCategory(entries, category)
            .slice(category ? safeOffset : 0, category ? safeOffset + safeLimit : safeLimit);

          if (filteredEntries.length === 0) {
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

          const text = filteredEntries
            .map((entry, i) => {
              const date = new Date(entry.timestamp)
                .toISOString()
                .split("T")[0];
              const categoryTag = getSmartDisplayCategoryTag(entry);
              return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Recent memories (showing ${filteredEntries.length}):\n\n${text}`,
              },
            ],
            details: {
              count: filteredEntries.length,
              memories: filteredEntries.map((e) => ({
                id: e.id,
                text: e.text,
                category: getSmartDisplayCategoryTag(e),
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
    { name: "mymem_list" },
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
        name: "mymem_promote",
        label: "Memory Promote",
        description:
          "Mark a useful auto-captured or pending memory as confirmed/durable after user confirmation or repeated evidence, so conservative recall treats it as trusted. Use for stable preferences, project rules, and proven lessons.",
        parameters: Type.Object({
          memoryId: Type.Optional(
            Type.String({ description: "Memory id or prefix to promote; omit when using query to locate it." }),
          ),
          query: Type.Optional(
            Type.String({ description: "Search query to locate the memory to promote when the ID is unknown." }),
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
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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
              ...buildPositiveUtilityMetadataPatch(parseSmartMetadata(before.metadata, before), runtimeContext.retriever.getConfig().learningMemory, now),
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
    { name: "mymem_promote" },
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
        name: "mymem_archive",
        label: "Memory Archive",
        description:
          "Archive stale, low-value, noisy, or superseded memory so default recall stops surfacing it while preserving history and audit trail. Prefer this over mymem_forget unless the user wants deletion or the memory is sensitive/invalid.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
          query: Type.Optional(Type.String({ description: "Search query to locate the memory to archive when the ID is unknown." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          reason: Type.Optional(Type.String({ description: "Archive reason for audit trail, such as stale, duplicate, superseded, noisy, or user_request." })),
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
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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
    { name: "mymem_archive" },
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
        name: "mymem_compact",
        label: "Memory Compact",
        description:
          "Find and optionally archive exact/near-duplicate low-value memories, linking redundant entries to a canonical memory. Use after noisy auto-capture periods or when stats/list show duplicate buildup. Defaults to dry-run preview.",
        parameters: Type.Object({
          scope: Type.Optional(Type.String({ description: "Optional scope filter for targeted cleanup." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only by default; set false only when you intend to archive duplicates." })),
          limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200; larger values cost more time)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { scope, dryRun = true, limit = 200 } = params as {
            scope?: string;
            dryRun?: boolean;
            limit?: number;
          };

          const safeLimit = clampInt(limit, 20, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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
            const key = `${meta.memory_category}:${normalizeInlineText(meta.summary).toLowerCase()}`;
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
            const now = Date.now();
            archivedCount = await runtimeContext.store.patchMetadataBatch(
              duplicates.map((item) => ({
                id: item.duplicateId,
                patch: {
                  state: "archived",
                  memory_layer: "archive",
                  canonical_id: item.canonicalId,
                  archive_reason: "compact_duplicate",
                  archived_at: now,
                },
              })),
              scopeFilter,
            );
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
    { name: "mymem_compact" },
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
        name: "mymem_explain_rank",
        label: "Memory Explain Rank",
        description:
          "Run recall and explain why each result ranked where it did, including vector/BM25/rerank scores and governance metadata. Use when a memory appears too high/low or suppression/state/layer may affect ranking.",
        parameters: Type.Object({
          query: Type.String({ description: "Query whose memory ranking needs analysis." }),
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
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
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
            source: "auto-recall",
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
            if (r.sources.learning) {
              sourceBreakdown.push(
                `learn=${r.sources.learning.finalScore.toFixed(3)}` +
                `/u=${r.sources.learning.utility.toFixed(2)}` +
                `/explore=${r.sources.learning.explorationBoost.toFixed(3)}` +
                `/bad=-${r.sources.learning.badRecallPenalty.toFixed(3)}`,
              );
            }
            return [
              `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
              `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
              `   kind=${meta.memory_kind} access=${meta.access_count} injected=${meta.injected_count} utility=${meta.utility_score.toFixed(2)} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
              `   text=${truncateText(normalizeInlineText(meta.summary || r.entry.text), 180)}`,
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
    { name: "mymem_explain_rank" },
  );
}
