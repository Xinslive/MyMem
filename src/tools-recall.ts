/**
 * Agent Tool Definitions — Memory Recall
 * Registration function for memory_recall tool.
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
} from "./tools-shared.js";
import { clampInt } from "./utils.js";
import { resolveScopeFilter } from "./scopes.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import type { MemoryType } from "./memory-categories.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { filterUserMdExclusiveRecallResults } from "./workspace-boundary.js";

export function registerMemoryRecallTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics. Pass type=\"knowledge\" for static/reference facts (profile, preferences, entities, patterns) or type=\"experience\" for past interactions and outcomes (events, cases).",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query for finding relevant memories",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
          }),
        ),
        includeFullText: Type.Optional(
          Type.Boolean({
            description: "Return full memory text when true (default: false returns summary previews)",
          }),
        ),
        maxCharsPerItem: Type.Optional(
          Type.Number({
            description: "Maximum characters per returned memory in summary mode (default: 180)",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Specific memory scope to search in (optional)",
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
          includeFullText = false,
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
            category,
            source: "manual",
          }, () => runtimeContext.store.count()), runtimeContext.workspaceBoundary);

          const typeFilter: MemoryType | undefined =
            type === "knowledge" || type === "experience" ? type : undefined;
          const results = typeFilter
            ? rawResults.filter(
                (r) =>
                  parseSmartMetadata(r.entry.metadata, r.entry).memory_type === typeFilter,
              )
            : rawResults;

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, query, scopes: scopeFilter, type: typeFilter ?? "both" },
            };
          }

          const now = Date.now();
          await Promise.allSettled(
            results.map((result) => {
              const meta = parseSmartMetadata(result.entry.metadata, result.entry);
              return runtimeContext.store.patchMetadata(
                result.entry.id,
                {
                  access_count: meta.access_count + 1,
                  last_accessed_at: now,
                  last_confirmed_use_at: now,
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                },
                scopeFilter,
              );
            }),
          );

          const text = results
            .map((r, i) => {
              const categoryTag = getDisplayCategoryTag(r.entry);
              const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
              const base = includeFullText
                ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
                : (metadata.l0_abstract || r.entry.text);
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
                metadata.l2_content || metadata.l1_overview || results[i].entry.text;
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
    { name: "memory_recall" },
  );
}
