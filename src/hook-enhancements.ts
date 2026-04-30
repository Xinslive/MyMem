/**
 * Hook-level memory enhancements.
 *
 * These hooks are intentionally soft interventions: they may inject warnings or
 * update metadata, but they never block tool execution or hard-delete memories.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Embedder } from "./embedder.js";
import type { PluginConfig } from "./plugin-types.js";
import type { ScopeManager } from "./scopes.js";
import { resolveScopeFilter } from "./scopes.js";
import type { MemoryEntry, MemorySearchResult, MemoryStore } from "./store.js";
import { resolveHookAgentId } from "./config-utils.js";
import { extractTextContent, redactSecrets } from "./session-utils.js";
import { isInternalReflectionSessionKey } from "./auto-capture-utils.js";
import { appendRelation, buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import { loadAgentReflectionSlicesFromEntries } from "./reflection-store.js";
import {
  containsStrongNegativeGovernanceFeedback,
  extractActiveConstraintHints,
  extractGovernanceRulesFromText,
  inferGovernanceRuleFromMemory,
  rulesConflict,
} from "./governance-rules.js";

const MAX_TRACKED_SESSIONS = 200;
const DEFAULT_CONTEXT_BUDGET_CHARS = 3_200;
const PLAYBOOK_MAX_CHARS = 900;
const SAFETY_HINT_MAX_CHARS = 900;
const OLD_MEMORY_AGE_MS = 1000 * 60 * 60 * 24 * 90;
const SESSION_PRIMER_QUERY = [
  "user preferences",
  "communication style",
  "assistant behavior guidance",
  "self correction rules",
  "constraints dislikes do-not-do preferences",
].join("; ");

type EnhancementKey = keyof NonNullable<PluginConfig["hookEnhancements"]>;
type InjectedSource = "auto-recall" | "session-primer";

type InjectedMemory = {
  id: string;
  text: string;
  scope: string;
  category: string;
  injectedAt: number;
  source: InjectedSource;
  ignoreCount?: number;
};

type SessionState = {
  injected: InjectedMemory[];
  lastUserText?: string;
  lastToolError?: string;
  lastTouchedFiles: string[];
  lastPromptAt?: number;
  turnCount: number;
};

export type HookEnhancementState = {
  sessions: Map<string, SessionState>;
};

type NormalizedSessionPrimerConfig = {
  enabled: boolean;
  preferDistilled: boolean;
  includeReflectionInvariants: boolean;
  maxItems: number;
  maxChars: number;
};

type NormalizedSelfCorrectionLoopConfig = {
  enabled: boolean;
  minConfidence: number;
  suppressTurns: number;
};

export function createHookEnhancementState(): HookEnhancementState {
  return { sessions: new Map() };
}

function enhancementEnabled(config: PluginConfig, key: EnhancementKey): boolean {
  const value = config.hookEnhancements?.[key];
  if (typeof value === "object" && value !== null && "enabled" in value) {
    return (value as { enabled?: boolean }).enabled !== false;
  }
  return value !== false;
}

function getSessionPrimerConfig(config: PluginConfig): NormalizedSessionPrimerConfig {
  const raw = config.hookEnhancements?.sessionPrimer;
  if (raw === false) {
    return { enabled: false, preferDistilled: true, includeReflectionInvariants: true, maxItems: 4, maxChars: 900 };
  }
  if (raw && typeof raw === "object") {
    return {
      enabled: raw.enabled !== false,
      preferDistilled: raw.preferDistilled !== false,
      includeReflectionInvariants: raw.includeReflectionInvariants !== false,
      maxItems: typeof raw.maxItems === "number" ? Math.max(1, Math.min(8, Math.floor(raw.maxItems))) : 4,
      maxChars: typeof raw.maxChars === "number" ? Math.max(200, Math.min(2_000, Math.floor(raw.maxChars))) : 900,
    };
  }
  return { enabled: true, preferDistilled: true, includeReflectionInvariants: true, maxItems: 4, maxChars: 900 };
}

function getSelfCorrectionLoopConfig(config: PluginConfig): NormalizedSelfCorrectionLoopConfig {
  const raw = config.hookEnhancements?.selfCorrectionLoop;
  if (raw === false) {
    return { enabled: false, minConfidence: 0.55, suppressTurns: 12 };
  }
  if (raw && typeof raw === "object") {
    return {
      enabled: raw.enabled !== false,
      minConfidence: typeof raw.minConfidence === "number" ? Math.max(0, Math.min(1, raw.minConfidence)) : 0.55,
      suppressTurns: typeof raw.suppressTurns === "number" ? Math.max(1, Math.min(100, Math.floor(raw.suppressTurns))) : 12,
    };
  }
  return { enabled: true, minConfidence: 0.55, suppressTurns: 12 };
}

function getSessionKey(event: any, ctx: any): string {
  const key = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : typeof event?.sessionKey === "string" ? event.sessionKey : "";
  return key.trim();
}

function shouldSkipSession(sessionKey: string): boolean {
  return !sessionKey || sessionKey.includes(":subagent:") || isInternalReflectionSessionKey(sessionKey);
}

function getState(state: HookEnhancementState, sessionKey: string): SessionState {
  let current = state.sessions.get(sessionKey);
  if (!current) {
    current = { injected: [], lastTouchedFiles: [], turnCount: 0 };
    state.sessions.set(sessionKey, current);
    if (state.sessions.size > MAX_TRACKED_SESSIONS) {
      const first = state.sessions.keys().next().value;
      if (first) state.sessions.delete(first);
    }
  }
  return current;
}

function uniquePush(values: string[], value: string, max = 12): string[] {
  const trimmed = value.trim();
  if (!trimmed) return values;
  return [...new Set([...values, trimmed])].slice(-max);
}

export function containsSensitiveContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return [
    /\b(?:sk|rk|pk|sess|pat)_[A-Za-z0-9_-]{16,}\b/,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]\s*['"]?[^\s'"`]{8,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  ].some((pattern) => pattern.test(trimmed));
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function hasNegativeRecallSignal(text: string): boolean {
  return /\b(wrong|incorrect|not relevant|irrelevant|outdated|stale|bad recall|misremembered|you remembered wrong)\b/i.test(text) ||
    /(?:不对|不是这样|记错|无关|过时|别再提|不要再用|错误的记忆)/.test(text) ||
    containsStrongNegativeGovernanceFeedback(text);
}

/**
 * Lightweight word-overlap check to detect when the user silently ignores
 * recalled memories (topic change / unrelated follow-up).
 * Returns true if the user message has very low relevance to the injected memories.
 */
function isSilentRecallIgnore(userMessage: string, injectedTexts: string[]): boolean {
  if (!userMessage.trim() || injectedTexts.length === 0) return false;
  const tokenize = (s: string) => {
    const words = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
    return new Set(words);
  };
  const userTokens = tokenize(userMessage);
  if (userTokens.size === 0) return false;
  const memoryTokens = new Set<string>();
  for (const text of injectedTexts) {
    for (const t of tokenize(text)) memoryTokens.add(t);
  }
  if (memoryTokens.size === 0) return false;
  let overlap = 0;
  for (const t of userTokens) {
    if (memoryTokens.has(t)) overlap++;
  }
  // Very low overlap ratio → likely topic change
  return overlap / Math.max(userTokens.size, 1) < 0.08 && overlap < 3;
}

function extractCorrection(text: string): { oldText: string; newText: string } | null {
  const CORRECTION_CONTEXT = /\b(actually|wrong|anymore|instead|shouldn'?t|停止|别再)\b/i;

  // Pattern 1: "not X, it's Y"
  const p1 = /(?:not|不是)\s+(.{2,80}?)\s*(?:,?\s*(?:it'?s|而是|是)\s+)(.{2,120})/i;
  const m1 = p1.exec(text);
  if (m1) return { oldText: m1[1].trim(), newText: m1[2].trim() };

  // Pattern 2: "change/update X to Y"
  const p2 = /(?:change|update|改成|更新为)\s+(.{2,80}?)\s+(?:to|为|成)\s+(.{2,120})/i;
  const m2 = p2.exec(text);
  if (m2) return { oldText: m2[1].trim(), newText: m2[2].trim() };

  // Pattern 3: "don't X, use/try Y instead" — two-capture form
  const p3 = /(?:以后不要|do not|don't)\s+(.{2,80}?)\s*,\s*(?:use|try|改为|改成|用)\s+(.{2,120})/i;
  const m3 = p3.exec(text);
  if (m3) return { oldText: m3[1].trim(), newText: m3[2].trim() };

  // Pattern 4: "don't X" — require correction context keywords to avoid false positives
  const p4 = /(?:以后不要|do not|don't)\s+(.{2,120})/i;
  const m4 = p4.exec(text);
  if (m4 && CORRECTION_CONTEXT.test(text)) {
    return { oldText: m4[1].trim(), newText: `Do not ${m4[1].trim()}` };
  }

  return null;
}

function extractToolName(event: any): string {
  return String(event?.toolName || event?.name || event?.tool || event?.call?.name || event?.toolCall?.name || "tool");
}

function extractToolText(event: any): string {
  const values = [event?.command, event?.args, event?.arguments, event?.input, event?.toolCall, event?.call, event?.result, event?.error]
    .filter((value) => value !== undefined);
  try {
    return values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  } catch {
    return values.map(String).join(" ");
  }
}

function isDangerousTool(toolName: string, text: string): boolean {
  const combined = `${toolName} ${text}`;
  return /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|drop\s+database|truncate\s+table|kubectl\s+delete|terraform\s+destroy|npm\s+publish|vercel\s+--prod|deploy|migration|migrate)\b/i.test(combined);
}

function extractTouchedFiles(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+(?:[\w.-]+)|(?:[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|go|rs|cs|java|yml|yaml))/g) || [];
  return [...new Set(matches)].slice(0, 20);
}

async function searchMemories(params: {
  store: MemoryStore;
  embedder: Embedder;
  query: string;
  scopeFilter?: string[];
  limit?: number;
  minScore?: number;
}): Promise<MemorySearchResult[]> {
  const vector = await params.embedder.embedQuery(params.query);
  return params.store.vectorSearch(vector, params.limit ?? 5, params.minScore ?? 0.12, params.scopeFilter, { excludeInactive: true });
}

function formatResults(results: MemorySearchResult[], maxChars: number): string {
  const lines = results.slice(0, 5).map((result, index) => {
    const meta = parseSmartMetadata(result.entry.metadata, result.entry);
    const label = meta.memory_category || result.entry.category || "memory";
    return `${index + 1}. [${label}:${result.entry.scope}] ${clip(redactSecrets(result.entry.text), 220)}`;
  });
  return clip(lines.join("\n"), maxChars);
}

function budgetBlock(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block;
  const lines = block.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.push("[memory hook context trimmed to fit budget]");
  return kept.join("\n");
}

function isSuppressedForTurn(metadata: ReturnType<typeof parseSmartMetadata>, currentTurn: number): boolean {
  return Number(metadata.suppressed_until_turn || 0) > 0 && currentTurn <= Number(metadata.suppressed_until_turn || 0);
}

function isPrimerPreferredMemory(result: MemorySearchResult): boolean {
  const meta = parseSmartMetadata(result.entry.metadata, result.entry);
  return meta.source_reason === "self_correction" ||
    meta.source_reason === "preference_distiller" ||
    meta.compiled_strategy === true ||
    Number(meta.evidence_count || 0) >= 2 ||
    Number(meta.stability_score || 0) >= 0.6 ||
    meta.memory_category === "preferences" ||
    meta.memory_category === "patterns";
}

function sortPrimerResults(results: MemorySearchResult[], currentTurn: number): MemorySearchResult[] {
  return [...results]
    .filter((result) => {
      const meta = parseSmartMetadata(result.entry.metadata, result.entry);
      return meta.state === "confirmed" &&
        meta.memory_layer !== "archive" &&
        meta.memory_layer !== "reflection" &&
        !isSuppressedForTurn(meta, currentTurn);
    })
    .sort((a, b) => {
      const aPreferred = isPrimerPreferredMemory(a) ? 1 : 0;
      const bPreferred = isPrimerPreferredMemory(b) ? 1 : 0;
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      return b.score - a.score;
    });
}

function buildSessionPrimerBlock(params: {
  distilledRules: string[];
  constraints: string[];
  invariants: string[];
  maxItems: number;
  maxChars: number;
}): string {
  let remaining = params.maxItems;
  const sections: Array<[string, string[]]> = [
    ["Distilled rules", params.distilledRules],
    ["Active constraints", params.constraints],
    ["Reflection invariants", params.invariants],
  ];
  const lines = ["<session-primer>"];

  for (const [heading, items] of sections) {
    if (remaining <= 0 || items.length === 0) continue;
    const selected = items.slice(0, remaining);
    lines.push(`${heading}:`);
    for (const item of selected) {
      lines.push(`- ${item}`);
      remaining--;
      if (remaining <= 0) break;
    }
  }

  lines.push("</session-primer>");
  return budgetBlock(lines.join("\n"), params.maxChars);
}

async function patchBadRecall(params: {
  store: MemoryStore;
  injected: InjectedMemory[];
  scopeFilter?: string[];
  reason: string;
}): Promise<void> {
  await Promise.allSettled(params.injected.slice(-8).map(async (item) => {
    const entry = await params.store.getById(item.id, params.scopeFilter);
    if (!entry) return;
    const meta = parseSmartMetadata(entry.metadata, entry);
    const badRecallCount = Number(meta.bad_recall_count || 0) + 1;
    await params.store.patchMetadata(item.id, {
      bad_recall_count: badRecallCount,
      suppressed_until_turn: Math.max(Number(meta.suppressed_until_turn || 0), badRecallCount >= 2 ? 12 : Number(meta.suppressed_until_turn || 0)),
      last_bad_recall_at: Date.now(),
      last_bad_recall_reason: params.reason,
    }, params.scopeFilter);
  }));
}

async function createSelfCorrectionMemory(params: {
  store: MemoryStore;
  embedder: Embedder;
  sessionKey: string;
  scope: string;
  text: string;
  memoryCategory: "preferences" | "patterns";
  storeCategory: "preference" | "other";
  confidence: number;
  canonicalId: string;
  supersedes?: string;
}): Promise<MemoryEntry> {
  const now = Date.now();
  const importance = params.memoryCategory === "preferences" ? 0.9 : 0.85;
  const vector = await params.embedder.embedPassage(params.text);
  return params.store.store({
    text: params.text,
    vector,
    importance,
    category: params.storeCategory,
    scope: params.scope,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        {
          text: params.text,
          category: params.storeCategory,
          importance,
          timestamp: now,
        },
        {
          l0_abstract: params.text,
          l1_overview: `- ${params.text}`,
          l2_content: params.text,
          memory_category: params.memoryCategory,
          confidence: params.confidence,
          source: "auto-capture",
          source_reason: "self_correction",
          source_session: params.sessionKey,
          evidence_count: 1,
          stability_score: params.confidence,
          canonical_id: params.canonicalId,
          state: "confirmed",
          memory_layer: params.memoryCategory === "preferences" ? "durable" : "working",
          last_confirmed_use_at: now,
          supersedes: params.supersedes,
          relations: params.supersedes ? appendRelation([], { type: "supersedes", targetId: params.supersedes }) : [],
        },
      ),
    ),
  });
}

async function applySelfCorrectionRule(params: {
  api: OpenClawPluginApi;
  store: MemoryStore;
  embedder: Embedder;
  sessionKey: string;
  scopeFilter?: string[];
  selfCorrectionLoop: NormalizedSelfCorrectionLoopConfig;
  ruleText: string;
}): Promise<void> {
  const rule = inferGovernanceRuleFromMemory(params.ruleText);
  if (!rule || rule.confidence < params.selfCorrectionLoop.minConfidence) return;

  const results = await searchMemories({
    store: params.store,
    embedder: params.embedder,
    query: `${rule.text}; ${rule.canonicalId}`,
    scopeFilter: params.scopeFilter,
    limit: 4,
    minScore: 0.08,
  });

  const sameTopic = results.filter((result) => {
    const meta = parseSmartMetadata(result.entry.metadata, result.entry);
    if (meta.state === "archived") return false;
    const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || result.entry.text, meta.memory_category);
    return inferred?.topic === rule.topic;
  });

  const exact = sameTopic.find((result) => {
    const meta = parseSmartMetadata(result.entry.metadata, result.entry);
    const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || result.entry.text, meta.memory_category);
    return inferred?.normalizedText === rule.normalizedText;
  });

  if (exact) {
    const meta = parseSmartMetadata(exact.entry.metadata, exact.entry);
    await params.store.patchMetadata(exact.entry.id, {
      canonical_id: rule.canonicalId,
      confidence: Math.max(Number(meta.confidence || 0.7), rule.confidence),
      source_reason: "self_correction",
      source_session: params.sessionKey,
      evidence_count: Math.max(Number(meta.evidence_count || 0), 1),
      last_confirmed_use_at: Date.now(),
    }, params.scopeFilter);
    return;
  }

  const conflicting = sameTopic.find((result) => {
    const meta = parseSmartMetadata(result.entry.metadata, result.entry);
    const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || result.entry.text, meta.memory_category);
    return rulesConflict(inferred, rule);
  });

  if (conflicting) {
    const conflictingMeta = parseSmartMetadata(conflicting.entry.metadata, conflicting.entry);
    if (conflicting.score >= 0.18 || conflictingMeta.canonical_id === rule.canonicalId) {
      const created = await createSelfCorrectionMemory({
        store: params.store,
        embedder: params.embedder,
        sessionKey: params.sessionKey,
        scope: conflicting.entry.scope,
        text: rule.text,
        memoryCategory: rule.memoryCategory,
        storeCategory: rule.storeCategory,
        confidence: rule.confidence,
        canonicalId: rule.canonicalId,
        supersedes: conflicting.entry.id,
      });
      await params.store.patchMetadata(conflicting.entry.id, {
        state: "archived",
        memory_layer: "archive",
        invalidated_at: Date.now(),
        superseded_by: created.id,
        prune_reason: "self_correction_superseded",
      }, params.scopeFilter);
      return;
    }
  }

  if (results[0]?.entry) {
    const topMeta = parseSmartMetadata(results[0].entry.metadata, results[0].entry);
    await params.store.patchMetadata(results[0].entry.id, {
      bad_recall_count: Number(topMeta.bad_recall_count || 0) + 1,
      suppressed_until_turn: Math.max(Number(topMeta.suppressed_until_turn || 0), params.selfCorrectionLoop.suppressTurns),
      last_bad_recall_at: Date.now(),
      last_bad_recall_reason: "self_correction_ambiguous",
    }, params.scopeFilter);
    return;
  }

  await createSelfCorrectionMemory({
    store: params.store,
    embedder: params.embedder,
    sessionKey: params.sessionKey,
    scope: params.scopeFilter?.[0] || "global",
    text: rule.text,
    memoryCategory: rule.memoryCategory,
    storeCategory: rule.storeCategory,
    confidence: rule.confidence,
    canonicalId: rule.canonicalId,
  });
}

export async function preflightAutoCaptureText(params: {
  config: PluginConfig;
  text: string;
  api?: Pick<OpenClawPluginApi, "logger">;
  source?: string;
}): Promise<boolean> {
  if (!enhancementEnabled(params.config, "privacyGuard")) return true;
  if (!containsSensitiveContent(params.text)) return true;
  params.api?.logger?.warn?.(`mymem: privacy guard skipped sensitive auto-capture text${params.source ? ` (${params.source})` : ""}`);
  return false;
}

export function registerHookEnhancements(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: Embedder;
  scopeManager: ScopeManager;
  state?: HookEnhancementState;
  isCliMode?: () => boolean;
}): HookEnhancementState {
  const { api, config, store, embedder, scopeManager } = params;
  const state = params.state ?? createHookEnhancementState();

  api.on("after_tool_call", (event: any, ctx: any) => {
    const sessionKey = getSessionKey(event, ctx);
    if (shouldSkipSession(sessionKey)) return;
    const session = getState(state, sessionKey);
    const text = extractToolText(event);
    session.lastTouchedFiles = extractTouchedFiles(text).reduce((acc, file) => uniquePush(acc, file), session.lastTouchedFiles);
    const failed = event?.success === false || event?.error || /\b(error|failed|exception|traceback)\b/i.test(text);
    if (failed) session.lastToolError = clip(`${extractToolName(event)}: ${text}`, 1_000);
  }, { priority: 8 });

  api.on("before_prompt_build", async (event: any, ctx: any) => {
    const sessionKey = getSessionKey(event, ctx);
    if (shouldSkipSession(sessionKey)) return;
    const agentId = resolveHookAgentId(typeof ctx?.agentId === "string" ? ctx.agentId : undefined, sessionKey);
    const scopeFilter = resolveScopeFilter(scopeManager, agentId);
    const session = getState(state, sessionKey);
    session.turnCount += 1;
    const currentTurn = session.turnCount;
    const blocks: Array<{ priority: number; text: string }> = [];

    // Silent negative feedback: detect when user ignores recalled memories
    if (enhancementEnabled(config, "badRecallFeedback") && session.injected.length > 0) {
      const userMsg = typeof event?.prompt === "string" ? event.prompt : "";
      const recentInjected = session.injected.filter((m) => Date.now() - m.injectedAt < 300_000);
      if (userMsg && recentInjected.length > 0 && isSilentRecallIgnore(userMsg, recentInjected.map((m) => m.text))) {
        for (const m of recentInjected) {
          m.ignoreCount = (m.ignoreCount || 0) + 1;
        }
        const toSuppress = recentInjected.filter((m) => (m.ignoreCount || 0) >= 3);
        if (toSuppress.length > 0) {
          try {
            await patchBadRecall({ store, injected: toSuppress, scopeFilter, reason: "recall_ignored" });
          } catch (err) {
            api.logger.debug?.(`mymem: silent bad-recall patch failed: ${String(err)}`);
          }
        }
      }
    }

    if (enhancementEnabled(config, "toolErrorPlaybook") && session.lastToolError) {
      try {
        const results = await searchMemories({ store, embedder, query: session.lastToolError, scopeFilter, limit: 4, minScore: 0.08 });
        const body = formatResults(results, PLAYBOOK_MAX_CHARS);
        if (body) {
          blocks.push({ priority: 100, text: `<tool-error-playbook>\nSimilar historical errors/learnings:\n${body}\n</tool-error-playbook>` });
        }
      } catch (err) {
        api.logger.debug?.(`mymem: tool error playbook recall failed: ${String(err)}`);
      }
    }

    const primerConfig = getSessionPrimerConfig(config);
    if (primerConfig.enabled && !session.lastPromptAt) {
      try {
        const primerQuery = `${SESSION_PRIMER_QUERY}; agent ${agentId}`;
        const searchResults = await searchMemories({ store, embedder, query: primerQuery, scopeFilter, limit: 8, minScore: 0.1 });
        const sorted = sortPrimerResults(searchResults, currentTurn);
        const distilledResults = primerConfig.preferDistilled
          ? sorted.filter(isPrimerPreferredMemory).slice(0, 4)
          : sorted.slice(0, 4);
        const constraints = extractActiveConstraintHints(
          typeof event?.prompt === "string" ? event.prompt : session.lastUserText || "",
          2,
        );
        const invariants = primerConfig.includeReflectionInvariants
          ? (() => {
            return store.list(scopeFilter, "reflection", 120, 0)
              .then((entries) => loadAgentReflectionSlicesFromEntries({ entries, agentId }).invariants.slice(0, 2))
              .catch(() => []);
          })()
          : Promise.resolve([]);
        const resolvedInvariants = await invariants;
        const primerBlock = buildSessionPrimerBlock({
          distilledRules: distilledResults.map((result) => parseSmartMetadata(result.entry.metadata, result.entry).l0_abstract || result.entry.text),
          constraints,
          invariants: resolvedInvariants,
          maxItems: primerConfig.maxItems,
          maxChars: primerConfig.maxChars,
        });
        if (primerBlock.includes("- ")) {
          blocks.push({ priority: 30, text: primerBlock });
          recordInjectedMemoriesForEnhancements({
            state,
            sessionKey,
            source: "session-primer",
            memories: distilledResults.map((result) => result.entry),
          });
        }
      } catch (err) {
        api.logger.debug?.(`mymem: session primer recall failed: ${String(err)}`);
      }
    }

    if (enhancementEnabled(config, "stalenessConfirmation")) {
      const stale = session.injected.filter((item) => Date.now() - item.injectedAt < 60_000);
      if (stale.length > 0) {
        const staleLines: string[] = [];
        for (const item of stale.slice(-5)) {
          const entry = await store.getById(item.id, scopeFilter).catch(() => null);
          if (!entry || Date.now() - entry.timestamp < OLD_MEMORY_AGE_MS) continue;
          staleLines.push(`- ${clip(entry.text, 160)}`);
        }
        if (staleLines.length > 0) {
          blocks.push({ priority: 20, text: `<memory-staleness-check>\nSome recalled memories are old; verify before relying on them.\n${staleLines.join("\n")}\n</memory-staleness-check>` });
        }
      }
    }

    session.lastPromptAt = Date.now();
    if (blocks.length === 0) return;
    const sorted = blocks.sort((a, b) => b.priority - a.priority).map((block) => block.text).join("\n\n");
    const maxChars = enhancementEnabled(config, "contextBudget") ? DEFAULT_CONTEXT_BUDGET_CHARS : Number.MAX_SAFE_INTEGER;
    return { prependContext: budgetBlock(sorted, maxChars), ephemeral: true };
  }, { priority: 18 });

  const dangerousToolHook = async (event: any, ctx: any) => {
    const sessionKey = getSessionKey(event, ctx);
    if (shouldSkipSession(sessionKey)) return;
    if (!enhancementEnabled(config, "dangerousToolHints")) return;
    const toolName = extractToolName(event);
    const toolText = extractToolText(event);
    if (!isDangerousTool(toolName, toolText)) return;
    const agentId = resolveHookAgentId(typeof ctx?.agentId === "string" ? ctx.agentId : undefined, sessionKey);
    const scopeFilter = resolveScopeFilter(scopeManager, agentId);
    try {
      const results = await searchMemories({ store, embedder, query: `${toolName} ${toolText}`, scopeFilter, limit: 4, minScore: 0.08 });
      const body = formatResults(results, SAFETY_HINT_MAX_CHARS);
      return {
        warning: `mymem: high-risk tool call detected for ${toolName}; review relevant memories before proceeding.`,
        prependContext: `<memory-safety-hint>\nHigh-risk tool call detected. This is advisory only; do not block execution solely because of this hint.\n${body}\n</memory-safety-hint>`,
        ephemeral: true,
      };
    } catch (err) {
      api.logger.debug?.(`mymem: dangerous tool hint recall failed: ${String(err)}`);
    }
  };
  api.registerHook?.("before_tool_call", dangerousToolHook, {
    name: "mymem.hook-enhancements.before-tool-call",
    description: "Advisory memory hints before high-risk tool calls",
  });
  api.on("before_tool_call", dangerousToolHook, { priority: 20 });

  api.on("agent_end", (event: any, ctx: any) => {
    const sessionKey = getSessionKey(event, ctx);
    if (shouldSkipSession(sessionKey)) return;
    const session = getState(state, sessionKey);
    const agentId = resolveHookAgentId(typeof ctx?.agentId === "string" ? ctx.agentId : undefined, sessionKey);
    const scopeFilter = resolveScopeFilter(scopeManager, agentId);
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const text = messages.map((msg: any) => extractTextContent(msg?.content) || "").filter(Boolean).join("\n");
    const latestUserText = [...messages].reverse()
      .find((msg: any) => msg?.role === "user" && extractTextContent(msg?.content)) as any;
    const latestUserContent = latestUserText ? extractTextContent(latestUserText.content)?.trim() : undefined;
    if (latestUserContent) session.lastUserText = latestUserContent;
    const userText = session.lastUserText || text;

    void (async () => {
      try {
        if (enhancementEnabled(config, "badRecallFeedback") && session.injected.length > 0 && hasNegativeRecallSignal(`${userText}\n${text}`)) {
          await patchBadRecall({ store, injected: session.injected, scopeFilter, reason: "negative_recall_signal" });
        }

        const selfCorrectionLoop = getSelfCorrectionLoopConfig(config);
        if (selfCorrectionLoop.enabled) {
          const correctionRules = extractGovernanceRulesFromText(userText || text)
            .filter((rule) => rule.confidence >= selfCorrectionLoop.minConfidence);
          for (const rule of correctionRules) {
            await applySelfCorrectionRule({
              api,
              store,
              embedder,
              sessionKey,
              scopeFilter,
              selfCorrectionLoop,
              ruleText: rule.text,
            });
          }
        }

        if (enhancementEnabled(config, "correctionDiff")) {
          const correction = extractCorrection(userText || text);
          if (correction) {
            const results = await searchMemories({ store, embedder, query: correction.oldText, scopeFilter, limit: 1, minScore: 0.12 });
            const match = results[0]?.entry;
            if (match) {
              const vector = await embedder.embedPassage(correction.newText);
              const oldMeta = parseSmartMetadata(match.metadata, match);
              const meta = buildSmartMetadata({ text: correction.newText, category: match.category, importance: match.importance }, {
                ...oldMeta,
                l0_abstract: correction.newText,
                l1_overview: `- ${correction.newText}`,
                l2_content: correction.newText,
                source_session: sessionKey,
                source: "auto-capture",
                source_reason: "self_correction",
                supersedes: match.id,
                state: "confirmed",
                last_confirmed_use_at: Date.now(),
              });
              const newEntry = await store.store({
                text: correction.newText,
                vector,
                importance: Math.max(match.importance, 0.75),
                category: match.category,
                scope: match.scope,
                metadata: stringifySmartMetadata(meta),
              });
              await store.patchMetadata(match.id, {
                superseded_by: newEntry.id,
                state: "archived",
                memory_layer: "archive",
                invalidated_at: Date.now(),
                correction_reason: clip(correction.oldText, 160),
              }, scopeFilter);
            }
          }
        }

        if (enhancementEnabled(config, "workspaceDrift") && session.lastTouchedFiles.length > 0 && session.injected.length > 0) {
          await Promise.allSettled(session.injected.slice(-8).map((item) => store.patchMetadata(item.id, {
            workspace_files: session.lastTouchedFiles.slice(-8),
            workspace_drift_updated_at: Date.now(),
          }, scopeFilter)));
        }
      } catch (err) {
        api.logger.warn?.(`mymem: hook enhancement agent_end failed: ${String(err)}`);
      }
    })();
  }, { priority: 18 });

  api.on("session_end", (_event: any, ctx: any) => {
    const sessionKey = getSessionKey(_event, ctx);
    if (sessionKey) state.sessions.delete(sessionKey);
  }, { priority: 99 });

  (params.isCliMode?.() ? api.logger.debug : api.logger.info)?.("mymem: hook enhancements registered");
  return state;
}

export function recordInjectedMemoriesForEnhancements(params: {
  state: HookEnhancementState;
  sessionKey: string;
  memories: Array<Pick<MemoryEntry, "id" | "text" | "scope" | "category">>;
  source?: InjectedSource;
}): void {
  if (shouldSkipSession(params.sessionKey) || params.memories.length === 0) return;
  const session = getState(params.state, params.sessionKey);
  const injectedAt = Date.now();
  session.injected = [
    ...session.injected,
    ...params.memories.map((entry) => ({
      id: entry.id,
      text: entry.text,
      scope: entry.scope,
      category: entry.category,
      injectedAt,
      source: params.source ?? "auto-recall",
    })),
  ].slice(-24);
}

export function createDefaultHookEnhancementsConfig() {
  return {
    badRecallFeedback: true,
    correctionDiff: true,
    toolErrorPlaybook: true,
    dangerousToolHints: true,
    contextBudget: true,
    privacyGuard: true,
    sessionPrimer: {
      enabled: true,
      preferDistilled: true,
      includeReflectionInvariants: true,
      maxItems: 4,
      maxChars: 900,
    },
    selfCorrectionLoop: {
      enabled: true,
      minConfidence: 0.55,
      suppressTurns: 12,
    },
    workspaceDrift: true,
    stalenessConfirmation: true,
  };
}
