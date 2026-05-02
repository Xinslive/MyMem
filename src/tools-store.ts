/**
 * Agent Tool Definitions — Memory Store
 * Registration function for mymem_store tool.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ToolContext,
  resolveToolContext,
  memoryCategoryEnum,
  clamp01,
  deriveManualMemoryCategory,
  deriveManualMemoryLayer,
  fallbackToolLogger,
  toLegacyMemoryCategory,
} from "./tools-shared.js";
import { stripEnvelopeMetadata } from "./smart-extractor.js";
import { isNoise } from "./noise-filter.js";
import { isSystemBypassId } from "./scopes.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";
import { isUserMdExclusiveMemory } from "./workspace-boundary.js";

export function registerMemoryStoreTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "mymem_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(
          Type.Number({ description: "Importance score 0-1 (default: 0.7)" }),
        ),
        category: Type.Optional(memoryCategoryEnum()),
        scope: Type.Optional(
          Type.String({
            description: "Memory scope (optional, defaults to agent scope)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          text,
          importance = 0.7,
          category = "other",
          scope,
        } = params as {
          text: string;
          importance?: number;
          category?: string;
          scope?: string;
        };

        try {
          // Guard: strip envelope metadata first, reject only if nothing remains (P2 fix)
          const stripped = stripEnvelopeMetadata(text);
          if (!stripped.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Skipped: text is purely envelope metadata with no extractable memory content.",
                },
              ],
              details: { action: "envelope_metadata_rejected", text: text.slice(0, 60) },
            };
          }

          const agentId = runtimeContext.agentId;
          // Determine target scope
          let targetScope = scope;
          if (!targetScope) {
            if (isSystemBypassId(agentId)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Reserved bypass agent IDs must provide an explicit scope for mymem_store writes.",
                  },
                ],
                details: {
                  error: "explicit_scope_required",
                  agentId,
                },
              };
            }
            targetScope = runtimeContext.scopeManager.getDefaultScope(agentId);
          }

          // Validate scope access
          if (!runtimeContext.scopeManager.isAccessible(targetScope, agentId)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Access denied to scope: ${targetScope}`,
                },
              ],
              details: {
                error: "scope_access_denied",
                requestedScope: targetScope,
              },
            };
          }

          // Reject noise before wasting an embedding API call
          if (isNoise(text)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
                },
              ],
              details: { action: "noise_filtered", text: text.slice(0, 60) },
            };
          }

          if (
            isUserMdExclusiveMemory(
              { text },
              runtimeContext.workspaceBoundary,
            )
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Skipped: this fact belongs in USER.md, not plugin memory.",
                },
              ],
              details: {
                action: "skipped_by_workspace_boundary",
                boundary: "user_md_exclusive",
              },
            };
          }

          const safeImportance = clamp01(importance, 0.7);
          const storeCategory = toLegacyMemoryCategory(category) ?? "other";
          const vector = await runtimeContext.embedder.embedPassage(stripped);

          // Temporal awareness: classify and infer expiry
          const temporalType = classifyTemporal(stripped);
          const validUntil = inferExpiry(stripped);
          // Check for duplicates / supersede candidates using raw vector similarity
          // (bypasses importance/recency weighting).
          // Fail-open by design: dedup must never block a legitimate memory write.
          // excludeInactive: superseded historical records must not block new writes.
          // Align with TEMPORAL_VERSIONED_CATEGORIES: only preference and entity
          // are semantically version-controlled. "fact"/"other" can reverse-map
          // to unrelated semantic categories, risking cross-supersede.
          const SUPERSEDE_ELIGIBLE: ReadonlySet<string> = new Set([
            "preference", "entity",
          ]);
          let existing: Awaited<ReturnType<import("./store.js").MemoryStore["vectorSearch"]>> = [];
          try {
            existing = await runtimeContext.store.vectorSearch(vector, 3, 0.1, [
              targetScope,
            ], { excludeInactive: true });
          } catch (err) {
            (runtimeContext.logger ?? fallbackToolLogger).warn(
              `mymem: duplicate pre-check failed, continue store: ${String(err)}`,
            );
          }

          if (existing.length > 0 && existing[0].score > 0.98) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].entry.id,
                existingText: existing[0].entry.text,
                existingScope: existing[0].entry.scope,
                similarity: existing[0].score,
              },
            };
          }

          // Auto-supersede: if a similar memory exists (0.95-0.98 similarity),
          // same storage-layer category, and category is eligible, mark the old
          // one as superseded and store the new one with a supersedes link.
          const supersedeCandidate = existing.find(
            (r) =>
              r.score > 0.95 &&
              r.score <= 0.98 &&
              r.entry.category === storeCategory &&
              SUPERSEDE_ELIGIBLE.has(r.entry.category),
          );

          if (supersedeCandidate) {
            const oldEntry = supersedeCandidate.entry;
            const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
            const now = Date.now();
            const factKey =
              oldMeta.fact_key ?? deriveFactKey(oldMeta.memory_category, text);

            // Store new memory with supersedes link, preserving canonical fields
            // from the old entry (aligns with mymem_update supersede path).
            const newMeta = buildSmartMetadata(
              { text, category: storeCategory, importance: safeImportance },
              {
                l0_abstract: text,
                l1_overview: oldMeta.l1_overview || `- ${text}`,
                l2_content: text,
                memory_category: oldMeta.memory_category,
                tier: oldMeta.tier,
                source: "manual",
                state: "confirmed",
                memory_layer: deriveManualMemoryLayer(storeCategory),
                last_confirmed_use_at: now,
                bad_recall_count: 0,
                suppressed_until_turn: 0,
                valid_from: now,
                fact_key: factKey,
                memory_temporal_type: temporalType,
                valid_until: validUntil,
                supersedes: oldEntry.id,
                relations: appendRelation([], {
                  type: "supersedes",
                  targetId: oldEntry.id,
                }),
              },
            );

            const newEntry = await runtimeContext.store.store({
              text,
              vector,
              importance: safeImportance,
              category: storeCategory,
              scope: targetScope,
              metadata: stringifySmartMetadata(newMeta),
            });

            // Invalidate old record
            try {
              await runtimeContext.store.patchMetadata(
                oldEntry.id,
                {
                  fact_key: factKey,
                  invalidated_at: now,
                  superseded_by: newEntry.id,
                  relations: appendRelation(oldMeta.relations, {
                    type: "superseded_by",
                    targetId: newEntry.id,
                  }),
                },
                [targetScope],
              );
            } catch (patchErr) {
              // New record is already the source of truth; log but don't fail
              (runtimeContext.logger ?? fallbackToolLogger).warn(
                `mymem: failed to patch superseded record ${oldEntry.id.slice(0, 8)}: ${patchErr}`,
              );
            }

            // Dual-write to Markdown mirror if enabled
            if (context.mdMirror) {
              try {
                await context.mdMirror(
                  { text, category: storeCategory, scope: targetScope, timestamp: newEntry.timestamp },
                  { source: "mymem_store", agentId },
                );
              } catch (mirrorErr) {
                (runtimeContext.logger ?? fallbackToolLogger).warn(
                  `mymem: mdMirror failed for supersede entry ${newEntry.id.slice(0, 8)}: ${mirrorErr}`,
                );
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Superseded memory ${oldEntry.id.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                },
              ],
              details: {
                action: "superseded",
                id: newEntry.id,
                supersededId: oldEntry.id,
                scope: newEntry.scope,
                category: newEntry.category,
                importance: newEntry.importance,
                similarity: supersedeCandidate.score,
              },
            };
          }

          const entry = await runtimeContext.store.store({
            text,
            vector,
            importance: safeImportance,
            category: storeCategory,
            scope: targetScope,
            metadata: stringifySmartMetadata(
              buildSmartMetadata(
                {
                  text,
                  category: storeCategory,
                  importance: safeImportance,
                },
                {
                  l0_abstract: text,
                  l1_overview: `- ${text}`,
                  l2_content: text,
                  memory_category: deriveManualMemoryCategory(storeCategory, text),
                  source: "manual",
                  state: "confirmed",
                  memory_layer: deriveManualMemoryLayer(storeCategory),
                  last_confirmed_use_at: Date.now(),
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                  memory_temporal_type: temporalType,
                  valid_until: validUntil,
                },
              ),
            ),
          });

          // Dual-write to Markdown mirror if enabled
          if (context.mdMirror) {
            try {
              await context.mdMirror(
                { text, category: storeCategory, scope: targetScope, timestamp: entry.timestamp },
                { source: "mymem_store", agentId },
              );
            } catch (mirrorErr) {
              (runtimeContext.logger ?? fallbackToolLogger).warn(
                `mymem: mdMirror failed for entry ${entry.id.slice(0, 8)}: ${mirrorErr}`,
              );
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${targetScope}'`,
              },
            ],
            details: {
              action: "created",
              id: entry.id,
              scope: entry.scope,
              category: entry.category,
              importance: entry.importance,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "store_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "mymem_store" },
  );
}
