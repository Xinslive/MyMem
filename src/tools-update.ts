/**
 * Agent Tool Definitions — Memory Update
 * Registration function for mymem_update tool.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ToolContext,
  resolveToolContext,
  resolveRuntimeAgentId,
  memoryCategoryEnum,
  clamp01,
  fallbackToolLogger,
  retrieveWithRetry,
  sanitizeMemoryForSerialization,
  toMemoryCategory,
} from "./tools-shared.js";
import type { MemoryEntry } from "./store.js";
import { isNoise } from "./noise-filter.js";
import { resolveScopeFilter } from "./scopes.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";
import {
  TEMPORAL_VERSIONED_CATEGORIES,
  type MemoryCategory,
} from "./memory-categories.js";
import { mapToStoreCategory } from "./smart-extractor-handlers.js";
import { buildPositiveUtilityMetadataPatch } from "./learning-memory.js";

export function registerMemoryUpdateTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "mymem_update",
      label: "Memory Update",
      description:
        "Correct or revise an existing memory when the user says a memory is wrong, stale, incomplete, or superseded by newer information. Use mymem_recall or mymem_list first when you need to identify the target. For preferences/entities, changing text creates a superseding version to preserve history; metadata-only changes update in-place.",
      parameters: Type.Object({
        memoryId: Type.String({
          description:
            "Target memory ID or 8+ char prefix; non-ID text is treated as a search query to locate the memory.",
        }),
        text: Type.Optional(
          Type.String({
            description: "Corrected canonical memory text; use for stale/wrong/incomplete memories, not ordinary current-turn facts.",
          }),
        ),
        importance: Type.Optional(
          Type.Number({ description: "New importance score 0-1; raise durable rules/preferences, lower marginal or uncertain memories." }),
        ),
        category: Type.Optional(memoryCategoryEnum()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { memoryId, text, importance, category } = params as {
          memoryId: string;
          text?: string;
          importance?: number;
          category?: string;
        };

        try {
          if (!text && importance === undefined && !category) {
            return {
              content: [
                {
                  type: "text",
                  text: "Nothing to update. Provide at least one of: text, importance, category.",
                },
              ],
              details: { error: "no_updates" },
            };
          }

          // Determine accessible scopes
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx, runtimeContext.logger);
          const scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);

          // Resolve memoryId: if it doesn't look like a UUID, try search
          let resolvedId = memoryId;
          const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
          if (!uuidLike) {
            // Treat as search query
            const results = await retrieveWithRetry(runtimeContext.retriever, {
              query: memoryId,
              limit: 3,
              scopeFilter,
            }, () => runtimeContext.store.count());
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No memory found matching "${memoryId}".`,
                  },
                ],
                details: { error: "not_found", query: memoryId },
              };
            }
            if (results.length === 1 || results[0].score > 0.85) {
              resolvedId = results[0].entry.id;
            } else {
              const list = results
                .map(
                  (r) =>
                    `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
                )
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple matches. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizeMemoryForSerialization(results),
                },
              };
            }
          }

          // If text changed, re-embed; reject noise
          let newVector: number[] | undefined;
          if (text) {
            if (isNoise(text)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Skipped: updated text detected as noise",
                  },
                ],
                details: { action: "noise_filtered" },
              };
            }
            newVector = await runtimeContext.embedder.embedPassage(text);
          }

          // Fetch existing entry once when we may need it (text change, or
          // importance/category-only changes that still need metadata sync).
          // Shared by the temporal supersede guard and the normal-path metadata
          // rebuild.
          let existing: MemoryEntry | null = null;
          if (text || importance !== undefined || category) {
            existing = await runtimeContext.store.getById(resolvedId, scopeFilter);
          }
          const requestedMemoryCategory = toMemoryCategory(category);
          if (category && !requestedMemoryCategory) {
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
          const learningMemory = runtimeContext.retriever.getConfig().learningMemory;

          // --- Temporal supersede guard ---
          // For temporal-versioned categories (preferences/entities), changing
          // text must go through supersede to preserve the history chain.
          if (text && newVector && existing) {
            const meta = parseSmartMetadata(existing.metadata, existing);
            if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
                const now = Date.now();
                const factKey =
                  meta.fact_key ?? deriveFactKey(meta.memory_category, text);

                // Create new superseding record
                const newMeta = buildSmartMetadata(
                  { text, category: existing.category },
                  {
                    l0_abstract: text,
                    l1_overview: meta.l1_overview,
                    l2_content: text,
                    memory_category: meta.memory_category,
                    tier: meta.tier,
                    access_count: 0,
                    confidence: importance !== undefined ? clamp01(importance, 0.7) : meta.confidence,
                    valid_from: now,
                    fact_key: factKey,
                    supersedes: resolvedId,
                    relations: appendRelation([], {
                      type: "supersedes",
                      targetId: resolvedId,
                    }),
                  },
                );

                const newEntry = await runtimeContext.store.store({
                  text,
                  vector: newVector,
                  category: requestedMemoryCategory
                    ? mapToStoreCategory(requestedMemoryCategory)
                    : existing.category,
                  scope: existing.scope,
                  importance:
                    importance !== undefined
                      ? clamp01(importance, 0.7)
                      : existing.importance,
                  metadata: stringifySmartMetadata(newMeta),
                });

                // Invalidate old record (metadata-only patch — safe)
                try {
                  const invalidatedMeta = buildSmartMetadata(existing, {
                    fact_key: factKey,
                    invalidated_at: now,
                    superseded_by: newEntry.id,
                    relations: appendRelation(meta.relations, {
                      type: "superseded_by",
                      targetId: newEntry.id,
                    }),
                  });
                  await runtimeContext.store.update(
                    resolvedId,
                    { metadata: stringifySmartMetadata(invalidatedMeta) },
                    scopeFilter,
                  );
                } catch (patchErr) {
                  // New record is already the source of truth; log but don't fail
                  (context.logger ?? fallbackToolLogger).warn(
                    `mymem: failed to patch superseded record ${resolvedId.slice(0, 8)}: ${patchErr}`,
                  );
                }

                return {
                  content: [
                    {
                      type: "text",
                      text: `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                    },
                  ],
                  details: {
                    action: "superseded",
                    oldId: resolvedId,
                    newId: newEntry.id,
                    category: meta.memory_category,
                  },
                };
            }
          }
          // --- End temporal supersede guard ---

          const updates: Record<string, unknown> = {};
          if (text) updates.text = text;
          if (newVector) updates.vector = newVector;
          if (importance !== undefined)
            updates.importance = clamp01(importance, 0.7);
          if (requestedMemoryCategory) updates.category = mapToStoreCategory(requestedMemoryCategory);

          // Rebuild smart metadata when text, importance, or memory category changes (#544)
          if ((text || requestedMemoryCategory) && existing) {
            const now = Date.now();
            const meta = parseSmartMetadata(existing.metadata, existing);
            const effectiveCategory: MemoryCategory = requestedMemoryCategory ?? meta.memory_category;
            const updatedMeta = buildSmartMetadata(existing, {
              ...(text
                ? {
                    l0_abstract: text,
                    l1_overview: `- ${text}`,
                    l2_content: text,
                    memory_temporal_type: classifyTemporal(text),
                  }
                : {}),
              memory_category: effectiveCategory,
              fact_key: deriveFactKey(effectiveCategory, text ?? meta.l0_abstract),
              confidence:
                importance !== undefined
                  ? clamp01(importance, 0.7)
                  : meta.confidence,
              ...buildPositiveUtilityMetadataPatch(meta, learningMemory, now),
            });
            // Re-derive valid_until from the new text. Explicit override
            // (not via patch.valid_until) so the absence of a new expiry
            // clears any stale value inherited from the previous text.
            if (text) updatedMeta.valid_until = inferExpiry(text);
            updates.metadata = stringifySmartMetadata(updatedMeta);
          } else if (importance !== undefined && existing) {
            // Sync confidence for importance-only changes
            const now = Date.now();
            const meta = parseSmartMetadata(existing.metadata, existing);
            const updatedMeta = buildSmartMetadata(existing, {
              confidence: clamp01(importance, 0.7),
              ...buildPositiveUtilityMetadataPatch(meta, learningMemory, now),
            });
            updates.metadata = stringifySmartMetadata(updatedMeta);
          }

          const updated = await runtimeContext.store.update(
            resolvedId,
            updates,
            scopeFilter,
          );

          if (!updated) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                },
              ],
              details: { error: "not_found", id: resolvedId },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "updated",
              id: updated.id,
              scope: updated.scope,
              category: updated.category,
              importance: updated.importance,
              fieldsUpdated: Object.keys(updates),
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "update_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "mymem_update" },
  );
}
