/**
 * Agent Tool Definitions — Memory Recall
 * Registration function for mymem_recall tool.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ToolContext,
  resolveToolContext,
  memoryCategoryEnum,
  stringEnum,
  normalizeInlineText,
  truncateText,
  sanitizeMemoryForSerialization,
  retrieveWithRetry,
  filterResultsByMemoryCategory,
  toStrictMemoryCategory,
} from "./tools-shared.js";
import { clampInt } from "./utils.js";
import { resolveScopeFilter } from "./scopes.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import type { MemoryType } from "./memory-categories.js";
import { getSmartDisplayCategoryTag } from "./reflection-metadata.js";
import { filterUserMdExclusiveRecallResults } from "./workspace-boundary.js";
import { buildPositiveUtilityMetadataPatch } from "./learning-memory.js";

export function registerMemoryRecallTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "mymem_recall",
      label: "Memory Recall",
      description:
        "Fallback manual memory recall. Use only when the current prompt and auto-recalled memories do not contain the memory needed to answer. Do not use for facts already present in the current prompt or injected auto-recall context. Useful before answering questions like \"what do you remember about...\" or when missing prior user preferences, project decisions, entities, lessons, or past outcomes could change the answer. Pass type=\"knowledge\" for stable/reference facts (profile, preferences, entities, patterns) or type=\"experience\" for past interactions and outcomes (events, cases).",
      parameters: Type.Object({
        query: Type.String({
          description: "Concrete memory search query; include user/project/entity names and the decision, preference, or past outcome you need.",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
          }),
        ),
        includeFullText: Type.Optional(
          Type.Boolean({
            description: "Return full memory text. Defaults to true; set false only when a compact summary preview is enough.",
          }),
        ),
        maxCharsPerItem: Type.Optional(
          Type.Number({
            description: "Maximum characters per returned memory in summary mode (default: 180)",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Specific memory scope to search in when the expected memory belongs to a known agent/project scope.",
          }),
        ),
        category: Type.Optional(memoryCategoryEnum()),
        type: Type.Optional(
          stringEnum(["knowledge", "experience", "both"] as const),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          query,
          limit = 3,
          includeFullText = true,
          maxCharsPerItem = 180,
          scope,
          category,
          type,
        } = params as {
          query: string;
          limit?: number;
          includeFullText?: boolean;
          maxCharsPerItem?: number;
          scope?: string;
          category?: string;
          type?: "knowledge" | "experience" | "both";
        };

        try {
          const safeLimit = includeFullText
            ? clampInt(limit, 1, 20)
            : clampInt(limit, 1, 6);
          const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);
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
          const agentId = runtimeContext.agentId;

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

          const rawResults = filterUserMdExclusiveRecallResults(await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
            source: "manual",
          }, () => runtimeContext.store.count()), runtimeContext.workspaceBoundary) as Awaited<ReturnType<typeof retrieveWithRetry>>;
          const categoryFilteredResults = filterResultsByMemoryCategory(rawResults, category);

          const typeFilter: MemoryType | undefined =
            type === "knowledge" || type === "experience" ? type : undefined;
          const results = typeFilter
            ? categoryFilteredResults.filter(
                (r) =>
                  parseSmartMetadata(r.entry.metadata, r.entry).memory_type === typeFilter,
              )
            : categoryFilteredResults;

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, query, scopes: scopeFilter, category, type: typeFilter ?? "both" },
            };
          }

          const now = Date.now();
          const learningMemory = runtimeContext.retriever.getConfig().learningMemory;
          await runtimeContext.store.patchMetadataBatch(
            results.map((result) => {
              const meta = parseSmartMetadata(result.entry.metadata, result.entry);
              return {
                id: result.entry.id,
                patch: {
                  access_count: meta.access_count + 1,
                  last_accessed_at: now,
                  ...buildPositiveUtilityMetadataPatch(meta, learningMemory, now),
                },
              };
            }),
            scopeFilter,
          );

          const text = results
            .map((r, i) => {
              const categoryTag = getSmartDisplayCategoryTag(r.entry);
              const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
              const base = includeFullText
                ? (metadata.content || r.entry.text)
                : (metadata.summary || r.entry.text);
              const inline = normalizeInlineText(base);
              const rendered = includeFullText
                ? inline
                : truncateText(inline, safeCharsPerItem);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${rendered}`;
            })
            .join("\n");

          const serializedMemories = sanitizeMemoryForSerialization(results);
          if (includeFullText) {
            for (let i = 0; i < results.length; i++) {
              const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
              (serializedMemories[i] as Record<string, unknown>).fullText =
                metadata.content || results[i].entry.text;
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `<relevant-memories>\n<mode:${includeFullText ? "full" : "summary"}>\nFound ${results.length} memories:\n\n${text}\n</relevant-memories>`,
              },
            ],
            details: {
              count: results.length,
              memories: serializedMemories,
              query,
              scopes: scopeFilter,
              retrievalMode: runtimeContext.retriever.getConfig().mode,
              recallMode: includeFullText ? "full" : "summary",
              category,
              type: typeFilter ?? "both",
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "recall_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "mymem_recall" },
  );
}
