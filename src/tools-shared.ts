/**
 * Agent Tool Definitions — Shared Utilities
 * Constants, types, and helper functions shared across tool modules.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRetriever, RetrievalContext, RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import { reverseMapLegacyCategory } from "./smart-metadata.js";
import type { MemoryCategory } from "./memory-categories.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { parseAgentIdFromSessionKey, type MemoryScopeManager } from "./scopes.js";
import type { WorkspaceBoundaryConfig } from "./workspace-boundary.js";
import type { AggregateStats } from "./retrieval-stats.js";
import type { ExtractionTelemetrySummary } from "./telemetry.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

const TOOL_CATEGORY_DESCRIPTION =
  "OpenClaw/storage compatibility category: preference, fact, decision, entity, reflection, other. MyMem also writes smart metadata memory_category: profile, preferences, entities, events, cases, patterns.";

export function memoryCategoryEnum() {
  return Type.Unsafe<(typeof MEMORY_CATEGORIES)[number]>({
    type: "string",
    enum: [...MEMORY_CATEGORIES],
    description: TOOL_CATEGORY_DESCRIPTION,
  });
}

export const fallbackToolLogger: Pick<OpenClawPluginApi["logger"], "warn"> = {
  warn: (...args) => console.warn(...args),
};

export type MdMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

export interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: Embedder;
  logger?: Pick<OpenClawPluginApi["logger"], "debug" | "info" | "warn" | "error">;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  telemetry?: {
    enabled: boolean;
    dir: string;
    filePaths: {
      retrieval: string;
      extraction: string;
    };
    getPersistentSummary(limit?: number): Promise<{
      retrieval: AggregateStats | null;
      extraction: ExtractionTelemetrySummary | null;
    }>;
  } | null;
}

export function resolveAgentId(runtimeAgentId: unknown, fallback?: string): string | undefined {
  if (typeof runtimeAgentId === "string" && runtimeAgentId.trim().length > 0) return runtimeAgentId;
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback;
  return undefined;
}

// ============================================================================
// Utility Functions
// ============================================================================

export function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

export function isLegacyMemoryCategory(category: string): category is (typeof MEMORY_CATEGORIES)[number] {
  return (MEMORY_CATEGORIES as readonly string[]).includes(category);
}

export function toLegacyMemoryCategory(category: string): (typeof MEMORY_CATEGORIES)[number] | undefined {
  return isLegacyMemoryCategory(category) ? category : undefined;
}

export function deriveManualMemoryCategory(category: string, text: string): MemoryCategory {
  return reverseMapLegacyCategory(toLegacyMemoryCategory(category), text);
}

export function deriveManualMemoryLayer(category: string): "durable" | "working" {
  if (category === "preference" || category === "decision" || category === "fact") {
    return "durable";
  }
  return "working";
}

export function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: getDisplayCategoryTag(r.entry),
    rawCategory: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
}

const _warnedMissingAgentId = new Set<string>();

/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState(): void {
  _warnedMissingAgentId.clear();
}

export function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  runtimeCtx: unknown,
  logger: Pick<OpenClawPluginApi["logger"], "warn"> = fallbackToolLogger,
): string {
  if (!runtimeCtx || typeof runtimeCtx !== "object") {
    const fallback = staticAgentId?.trim();
    if (!fallback && !_warnedMissingAgentId.has("no-context")) {
      _warnedMissingAgentId.add("no-context");
      logger.warn(
        "resolveRuntimeAgentId: no runtime context or static agentId, defaulting to 'main'. " +
        "Tool callers without explicit agentId will be scoped to agent:main + global + reflection:agent:main."
      );
    }
    return fallback || "main";
  }
  const ctx = runtimeCtx as Record<string, unknown>;
  const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
  const trimmed = resolved?.trim();
  if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
    _warnedMissingAgentId.add("empty-resolved");
    logger.warn(
      "resolveRuntimeAgentId: resolved agentId is empty after trim, defaulting to 'main'."
    );
  }
  return trimmed ? trimmed : "main";
}

export function resolveToolContext(
  base: ToolContext,
  runtimeCtx: unknown,
): ToolContext {
  return {
    ...base,
    agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx, base.logger),
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function retrieveWithRetry(
  retriever: MemoryRetriever,
  params: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    category?: string;
    source?: RetrievalContext["source"];
  },
  countStore?: () => Promise<number>,
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(params);
  if (results.length === 0) {
    // Skip retry if store is empty — nothing to catch up via write-ahead lag.
    if (countStore) {
      const total = await countStore();
      if (total === 0) return results;
    }
    await sleep(75);
    results = await retriever.retrieve(params);
  }
  return results;
}

export async function resolveMemoryId(
  context: ToolContext,
  memoryRef: string,
  scopeFilter: string[],
): Promise<
  | { ok: true; id: string }
  | { ok: false; message: string; details?: Record<string, unknown> }
> {
  const trimmed = memoryRef.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "memoryId/query 不能为空。",
      details: { error: "empty_memory_ref" },
    };
  }

  const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(trimmed);
  if (uuidLike) {
    return { ok: true, id: trimmed };
  }

  const results = await retrieveWithRetry(context.retriever, {
    query: trimmed,
    limit: 5,
    scopeFilter,
  }, () => context.store.count());
  if (results.length === 0) {
    return {
      ok: false,
      message: `No memory found matching "${trimmed}".`,
      details: { error: "not_found", query: trimmed },
    };
  }
  if (results.length === 1 || results[0].score > 0.85) {
    return { ok: true, id: results[0].entry.id };
  }

  const list = results
    .map(
      (r) =>
        `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
    )
    .join("\n");
  return {
    ok: false,
    message: `Multiple matches. Specify memoryId:\n${list}`,
    details: {
      action: "candidates",
      candidates: sanitizeMemoryForSerialization(results),
    },
  };
}

export function resolveWorkspaceDir(toolCtx: unknown, fallback?: string): string {
  const runtime = toolCtx as Record<string, unknown> | undefined;
  const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
  if (runtimePath) return runtimePath;
  if (fallback && fallback.trim()) return fallback;
  return join(homedir(), ".openclaw", "workspace");
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LearningBacklogEntry {
  id: string;
  file: "LEARNINGS.md" | "ERRORS.md";
  priority: string;
  status: string;
  area: string;
  summary: string;
  suggestedAction: string;
}

export function extractLearningSection(entry: string, heading: string): string {
  const escapedHeading = escapeRegExp(heading);
  const match = entry.match(new RegExp(`### ${escapedHeading}\\n([\\s\\S]*?)(?=\\n### |\\n---|$)`, "m"));
  return (match?.[1] ?? "").trim();
}

export function extractLearningField(entry: string, field: string): string {
  const escapedField = escapeRegExp(field);
  const match = entry.match(new RegExp(`\\*\\*${escapedField}\\*\\*:\\s*(.+)`, "i"));
  return (match?.[1] ?? "").trim();
}

export function parseLearningBacklogEntries(file: "LEARNINGS.md" | "ERRORS.md", content: string): LearningBacklogEntry[] {
  const chunks = content.match(/^## \[(LRN|ERR)-\d{8}-\d{3}\][^\n]*[\s\S]*?(?=\n## \[(?:LRN|ERR)-|(?![\s\S]))/gm) || [];
  return chunks.map((chunk) => {
    const id = chunk.match(/^## \[((?:LRN|ERR)-\d{8}-\d{3})\]/m)?.[1] ?? "";
    return {
      id,
      file,
      priority: extractLearningField(chunk, "Priority") || "medium",
      status: extractLearningField(chunk, "Status") || "pending",
      area: extractLearningField(chunk, "Area") || "general",
      summary: extractLearningSection(chunk, "Summary"),
      suggestedAction: extractLearningSection(chunk, "Suggested Action"),
    };
  }).filter((entry) => entry.id && entry.summary);
}

export function normalizeDistillRuleText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .replace(/^Review (?:possible learning|failure) before \/(?:new|reset):\s*/i, "")
    .trim()
    .replace(/[.。]+$/, "");
}

export function buildSelfImprovementDistillPatch(entries: LearningBacklogEntry[], targetFile: string): string {
  const uniqueRules = new Map<string, LearningBacklogEntry>();
  for (const entry of entries) {
    const source = entry.suggestedAction && entry.suggestedAction !== "-" ? entry.suggestedAction : entry.summary;
    const rule = normalizeDistillRuleText(source);
    if (!rule) continue;
    const key = rule.toLowerCase();
    if (!uniqueRules.has(key)) uniqueRules.set(key, entry);
  }
  const lines = Array.from(uniqueRules.values()).map((entry) => {
    const source = entry.suggestedAction && entry.suggestedAction !== "-" ? entry.suggestedAction : entry.summary;
    const rule = normalizeDistillRuleText(source);
    return `- ${rule}. (source: ${entry.id}, area: ${entry.area}, priority: ${entry.priority})`;
  });
  return [
    `--- a/${targetFile}`,
    `+++ b/${targetFile}`,
    "@@",
    "+## Self-Improvement Distilled Rules",
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}
