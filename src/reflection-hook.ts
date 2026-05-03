/**
 * Memory Reflection Hook Registration
 *
 * Extracted from index.ts to reduce the main plugin file size.
 * Handles: error signal collection, inheritance/derived injection,
 * session cleanup, and reflection generation on command:new/reset.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, ReflectionErrorSignal, ReflectionErrorState } from "./plugin-types.js";
import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { ScopeManager } from "./scopes.js";
import type { LlmClient } from "./llm-client.js";
import type { MdMirrorWriter } from "./workspace-utils.js";
import type { FeedbackLoop } from "./feedback-loop.js";

import { DEFAULT_REFLECTION_MESSAGE_COUNT, DEFAULT_REFLECTION_MAX_INPUT_CHARS, DEFAULT_REFLECTION_TIMEOUT_MS, DEFAULT_REFLECTION_THINK_LEVEL, DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES, DEFAULT_REFLECTION_SESSION_TTL_MS, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS } from "./plugin-constants.js";
import { join } from "node:path";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { containsErrorSignal, summarizeErrorText, sha256Hex, normalizeErrorSignature, extractTextFromToolResult } from "./session-utils.js";
import { parsePositiveInt, resolveHookAgentId } from "./config-utils.js";
import { asNonEmptyString, sanitizeFileToken } from "./cli-utils.js";
import { generateReflectionText } from "./reflection-cli.js";
import { resolveRuntimeEmbeddedPiRunner } from "./openclaw-extension-utils.js";
import { findPreviousSessionFile } from "./workspace-utils.js";
import { readSessionConversationWithResetFallback, ensureDailyLogFile } from "./session-recovery-utils.js";
import { isAgentDeclaredInConfig } from "./agent-config-utils.js";
import { resolveScopeFilter, isSystemBypassId, parseAgentIdFromSessionKey } from "./scopes.js";
import { isInternalReflectionSessionKey } from "./auto-capture-utils.js";
import { resolveWorkspaceDirFromContext } from "./path-utils.js";
import { parseSmartMetadata } from "./smart-metadata.js";
import { storeReflectionToLanceDB, loadAgentReflectionSlicesFromEntries, DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS } from "./reflection-store.js";
import { extractReflectionLearningGovernanceCandidates, extractInjectableReflectionMappedMemoryItems } from "./reflection-slices.js";
import { createReflectionEventId } from "./reflection-event-store.js";
import { buildReflectionMappedMetadata } from "./reflection-mapped-metadata.js";
import { appendSelfImprovementEntry } from "./self-improvement-files.js";
import { dedupHookEvent } from "./hook-dedup.js";
import { normalizeAdmissionControlConfig } from "./admission-control.js";
import { resolveReflectionSessionSearchDirs } from "./session-recovery.js";

// ============================================================================
// Types
// ============================================================================

/** Minimal singleton state subset needed by the reflection hook. */
interface ReflectionHookSingletonState {
  reflectionErrorStateBySession: Map<string, ReflectionErrorState>;
  reflectionDerivedBySession: Map<string, { updatedAt: number; derived: string[] }>;
  reflectionByAgentCache: Map<string, { updatedAt: number; invariants: string[]; derived: string[] }>;
  feedbackLoop: FeedbackLoop | null;
}

export interface ReflectionHookParams {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: Embedder;
  scopeManager: ScopeManager;
  mdMirror: MdMirrorWriter | null;
  smartExtractionLlmClient: LlmClient | null;
  resolvedDbPath: string;
  singletonState: ReflectionHookSingletonState;
  isCliMode: () => boolean;
}

// ============================================================================
// Helper utilities (extracted from index.ts register() closure)
// ============================================================================

function pruneOldestByUpdatedAt<T extends { updatedAt: number }>(map: Map<string, T>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const removeCount = map.size - maxSize;
  for (let i = 0; i < removeCount; i++) {
    const key = sorted[i]?.[0];
    if (key) map.delete(key);
  }
}

function createReflectionSessionHelpers(state: {
  reflectionErrorStateBySession: Map<string, ReflectionErrorState>;
  reflectionDerivedBySession: Map<string, { updatedAt: number; derived: string[] }>;
  reflectionByAgentCache: Map<string, { updatedAt: number; invariants: string[]; derived: string[] }>;
}) {
  const pruneReflectionSessionState = (now = Date.now()) => {
    for (const [key, s] of state.reflectionErrorStateBySession.entries()) {
      if (now - s.updatedAt > DEFAULT_REFLECTION_SESSION_TTL_MS) state.reflectionErrorStateBySession.delete(key);
    }
    for (const [key, s] of state.reflectionDerivedBySession.entries()) {
      if (now - s.updatedAt > DEFAULT_REFLECTION_SESSION_TTL_MS) state.reflectionDerivedBySession.delete(key);
    }
    pruneOldestByUpdatedAt(state.reflectionErrorStateBySession, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
    pruneOldestByUpdatedAt(state.reflectionDerivedBySession, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
  };

  const getReflectionErrorState = (sessionKey: string): ReflectionErrorState => {
    const key = sessionKey.trim();
    const current = state.reflectionErrorStateBySession.get(key);
    if (current) { current.updatedAt = Date.now(); return current; }
    const created: ReflectionErrorState = { entries: [], lastInjectedCount: 0, signatureSet: new Set<string>(), updatedAt: Date.now() };
    state.reflectionErrorStateBySession.set(key, created);
    return created;
  };

  const addReflectionErrorSignal = (sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean) => {
    if (!sessionKey.trim()) return;
    pruneReflectionSessionState();
    const s = getReflectionErrorState(sessionKey);
    if (dedupeEnabled && s.signatureSet.has(signal.signatureHash)) return;
    s.entries.push(signal);
    s.signatureSet.add(signal.signatureHash);
    s.updatedAt = Date.now();
    if (s.entries.length > 30) {
      const removed = s.entries.length - 30;
      s.entries.splice(0, removed);
      s.lastInjectedCount = Math.max(0, s.lastInjectedCount - removed);
      s.signatureSet = new Set(s.entries.map((e) => e.signatureHash));
    }
  };

  const getPendingReflectionErrorSignalsForPrompt = (sessionKey: string, maxEntries: number): ReflectionErrorSignal[] => {
    pruneReflectionSessionState();
    const s = state.reflectionErrorStateBySession.get(sessionKey.trim());
    if (!s) return [];
    s.updatedAt = Date.now();
    s.lastInjectedCount = Math.min(s.lastInjectedCount, s.entries.length);
    const pending = s.entries.slice(s.lastInjectedCount);
    if (pending.length === 0) return [];
    const clipped = pending.slice(-maxEntries);
    s.lastInjectedCount = s.entries.length;
    return clipped;
  };

  const loadAgentReflectionSlices = async (agentId: string, store: MemoryStore, scopeFilter?: string[]) => {
    const scopeKey = Array.isArray(scopeFilter) ? `scopes:${[...scopeFilter].sort().join(",")}` : "<NO_SCOPE_FILTER>";
    const cacheKey = `${agentId}::${scopeKey}`;
    const cached = state.reflectionByAgentCache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < 15_000) return cached;

    let entries = await store.list(scopeFilter, "reflection", 240, 0);
    let slices = loadAgentReflectionSlicesFromEntries({ entries, agentId, deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS });
    if (slices.invariants.length === 0 && slices.derived.length === 0) {
      const legacyEntries = await store.list(scopeFilter, undefined, 240, 0);
      entries = legacyEntries.filter((entry) => {
        try { return parseSmartMetadata(entry.metadata, entry).source === "reflection" && parseSmartMetadata(entry.metadata, entry).source_session === agentId; } catch { return false; }
      });
      slices = loadAgentReflectionSlicesFromEntries({ entries, agentId, deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS });
    }
    const { invariants, derived } = slices;
    const next = { updatedAt: Date.now(), invariants, derived };
    state.reflectionByAgentCache.set(cacheKey, next);
    return next;
  };

  return { pruneReflectionSessionState, getReflectionErrorState, addReflectionErrorSignal, getPendingReflectionErrorSignalsForPrompt, loadAgentReflectionSlices };
}

// ============================================================================
// Main registration
// ============================================================================

export function registerMemoryReflectionHook(params: ReflectionHookParams): void {
  const { api, config, store, embedder, scopeManager, mdMirror, smartExtractionLlmClient: _smartExtractionLlmClient, resolvedDbPath, singletonState, isCliMode } = params;
  const {
    reflectionErrorStateBySession,
    reflectionDerivedBySession,
    reflectionByAgentCache,
  } = singletonState;

  if (config.sessionStrategy !== "memoryReflection") return;

  const helpers = createReflectionSessionHelpers({
    reflectionErrorStateBySession,
    reflectionDerivedBySession,
    reflectionByAgentCache,
  });

  // ── Config ──
  const reflectionMessageCount = config.memoryReflection?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
  const reflectionMaxInputChars = config.memoryReflection?.maxInputChars ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS;
  const reflectionTimeoutMs = config.memoryReflection?.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
  const reflectionThinkLevel = config.memoryReflection?.thinkLevel ?? DEFAULT_REFLECTION_THINK_LEVEL;
  const reflectionAgentId = asNonEmptyString(config.memoryReflection?.agentId);
  const reflectionErrorReminderMaxEntries = parsePositiveInt(config.memoryReflection?.errorReminderMaxEntries) ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES;
  const reflectionDedupeErrorSignals = config.memoryReflection?.dedupeErrorSignals !== false;
  const reflectionInjectMode = config.memoryReflection?.injectMode ?? "inheritance+derived";
  const reflectionStoreToLanceDB = config.memoryReflection?.storeToLanceDB !== false;
  const reflectionWriteLegacyCombined = config.memoryReflection?.writeLegacyCombined !== false;
  const warnedInvalidReflectionAgentIds = new Set<string>();

  const resolveReflectionRunAgentId = (cfg: unknown, sourceAgentId: string): string => {
    if (!reflectionAgentId) return sourceAgentId;
    if (isAgentDeclaredInConfig(cfg, reflectionAgentId)) return reflectionAgentId;
    if (!warnedInvalidReflectionAgentIds.has(reflectionAgentId)) {
      api.logger.warn(`memory-reflection: memoryReflection.agentId "${reflectionAgentId}" not found in cfg.agents.list; fallback to runtime agent "${sourceAgentId}".`);
      warnedInvalidReflectionAgentIds.add(reflectionAgentId);
    }
    return sourceAgentId;
  };

  // ── Hook: after_tool_call (error signal collection) ──
  api.on("after_tool_call", (event: any, ctx: any) => {
    const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
    if (isInternalReflectionSessionKey(sessionKey)) return;
    if (!sessionKey) return;
    helpers.pruneReflectionSessionState();

    if (typeof event.error === "string" && event.error.trim().length > 0) {
      const signature = normalizeErrorSignature(event.error);
      const summary = summarizeErrorText(event.error);
      const signatureHash = sha256Hex(signature).slice(0, 16);
      helpers.addReflectionErrorSignal(sessionKey, {
        at: Date.now(), toolName: event.toolName || "unknown",
        summary, source: "tool_error",
        signature, signatureHash,
      }, reflectionDedupeErrorSignals);
      singletonState.feedbackLoop?.onPreventiveLessonEvidence({
        summary,
        details: event.error,
        source: "tool_error",
        sessionKey,
        scopeFilter: resolveScopeFilter(scopeManager, resolveHookAgentId(typeof ctx.agentId === "string" ? ctx.agentId : undefined, sessionKey)),
        toolName: event.toolName || "unknown",
        signatureHash,
      });
      return;
    }

    const resultTextRaw = extractTextFromToolResult(event.result);
    const resultText = resultTextRaw.length > DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS ? resultTextRaw.slice(0, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS) : resultTextRaw;
    if (resultText && containsErrorSignal(resultText)) {
      const signature = normalizeErrorSignature(resultText);
      const summary = summarizeErrorText(resultText);
      const signatureHash = sha256Hex(signature).slice(0, 16);
      helpers.addReflectionErrorSignal(sessionKey, {
        at: Date.now(), toolName: event.toolName || "unknown",
        summary, source: "tool_output",
        signature, signatureHash,
      }, reflectionDedupeErrorSignals);
      singletonState.feedbackLoop?.onPreventiveLessonEvidence({
        summary,
        details: resultText,
        source: "tool_output",
        sessionKey,
        scopeFilter: resolveScopeFilter(scopeManager, resolveHookAgentId(typeof ctx.agentId === "string" ? ctx.agentId : undefined, sessionKey)),
        toolName: event.toolName || "unknown",
        signatureHash,
      });
    }
  }, { priority: 15 });

  // ── Hook: before_prompt_build (inheritance injection) ──
  api.on("before_prompt_build", async (_event: any, ctx: any) => {
    const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
    if (sessionKey.includes(":subagent:")) return;
    if (isInternalReflectionSessionKey(sessionKey)) return;
    if (reflectionInjectMode !== "inheritance-only" && reflectionInjectMode !== "inheritance+derived") return;
    try {
      helpers.pruneReflectionSessionState();
      const agentId = resolveHookAgentId(typeof ctx.agentId === "string" ? ctx.agentId : undefined, sessionKey);
      const scopes = resolveScopeFilter(scopeManager, agentId);
      const slices = await helpers.loadAgentReflectionSlices(agentId, store, scopes);
      if (slices.invariants.length === 0) return;
      const body = slices.invariants.slice(0, 6).map((line, i) => `${i + 1}. ${line}`).join("\n");
      return { prependContext: ["<inherited-rules>", "Stable rules inherited from mymem reflections. Treat as long-term behavioral constraints unless user overrides.", body, "</inherited-rules>"].join("\n") };
    } catch (err) {
      api.logger.warn(`memory-reflection: inheritance injection failed: ${String(err)}`);
    }
  }, { priority: 12 });

  // ── Hook: before_prompt_build (derived + error injection) ──
  api.on("before_prompt_build", async (_event: any, ctx: any) => {
    const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
    if (sessionKey.includes(":subagent:")) return;
    if (isInternalReflectionSessionKey(sessionKey)) return;
    const agentId = resolveHookAgentId(typeof ctx.agentId === "string" ? ctx.agentId : undefined, sessionKey);
    helpers.pruneReflectionSessionState();

    const blocks: string[] = [];
    if (reflectionInjectMode === "inheritance+derived") {
      try {
        const scopes = resolveScopeFilter(scopeManager, agentId);
        const derivedCache = sessionKey ? reflectionDerivedBySession.get(sessionKey) : null;
        const derivedLines = derivedCache?.derived?.length ? derivedCache.derived : (await helpers.loadAgentReflectionSlices(agentId, store, scopes)).derived;
        if (derivedLines.length > 0) {
          blocks.push(["<derived-focus>", "Weighted recent derived execution deltas from reflection memory:", ...derivedLines.slice(0, 6).map((line, i) => `${i + 1}. ${line}`), "</derived-focus>"].join("\n"));
        }
      } catch (err) {
        api.logger.warn(`memory-reflection: derived injection failed: ${String(err)}`);
      }
    }

    if (sessionKey) {
      const pending = helpers.getPendingReflectionErrorSignalsForPrompt(sessionKey, reflectionErrorReminderMaxEntries);
      if (pending.length > 0) {
        blocks.push(["<error-detected>", "A tool error was detected. Consider logging this to `.learnings/ERRORS.md` if it is non-trivial or likely to recur.", "Recent error signals:", ...pending.map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary}`), "</error-detected>"].join("\n"));
      }
    }

    if (blocks.length === 0) return;
    return { prependContext: blocks.join("\n\n") };
  }, { priority: 15 });

  // ── Hook: session_end (cleanup) ──
  api.on("session_end", (_event: any, ctx: any) => {
    const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (!sessionKey) return;
    reflectionErrorStateBySession.delete(sessionKey);
    reflectionDerivedBySession.delete(sessionKey);
    helpers.pruneReflectionSessionState();
  }, { priority: 20 });

  // ── Global re-entrant guard ──
  const GLOBAL_REFLECTION_LOCK = Symbol.for("openclaw.mymem.reflection-lock");
  const getGlobalReflectionLock = (): Map<string, boolean> => {
    const g = globalThis as Record<symbol, unknown>;
    if (!g[GLOBAL_REFLECTION_LOCK]) g[GLOBAL_REFLECTION_LOCK] = new Map<string, boolean>();
    return g[GLOBAL_REFLECTION_LOCK] as Map<string, boolean>;
  };

  const REFLECTION_SERIAL_GUARD = Symbol.for("openclaw.mymem.reflection-serial-guard");
  const getSerialGuardMap = () => {
    const g = globalThis as any;
    if (!g[REFLECTION_SERIAL_GUARD]) g[REFLECTION_SERIAL_GUARD] = new Map<string, number>();
    return g[REFLECTION_SERIAL_GUARD] as Map<string, number>;
  };
  const SERIAL_GUARD_COOLDOWN_MS = 120_000;

  // ── Main reflection handler ──
  const runMemoryReflection = async (event: any) => {
    const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
    if (!sessionKey) return;

    if (dedupHookEvent("reflection", event)) return;
    const globalLock = getGlobalReflectionLock();
    if (sessionKey && globalLock.get(sessionKey)) {
      api.logger.info(`memory-reflection: skipping re-entrant call for sessionKey=${sessionKey}; already running (global guard)`);
      return;
    }
    if (sessionKey) {
      const serialGuard = getSerialGuardMap();
      const lastRun = serialGuard.get(sessionKey);
      if (lastRun && (Date.now() - lastRun) < SERIAL_GUARD_COOLDOWN_MS) {
        api.logger.info(`memory-reflection: skipping serial re-trigger for sessionKey=${sessionKey}; last run ${(Date.now() - lastRun) / 1000}s ago (cooldown=${SERIAL_GUARD_COOLDOWN_MS / 1000}s)`);
        return;
      }
    }
    if (sessionKey) globalLock.set(sessionKey, true);
    let reflectionRan = false;
    try {
      helpers.pruneReflectionSessionState();
      const action = String(event?.action || "unknown");
      const context = (event.context || {}) as Record<string, unknown>;
      const cfg = context.cfg;
      const workspaceDir = resolveWorkspaceDirFromContext(context);
      if (!cfg) { api.logger.warn(`memory-reflection: command:${action} missing cfg in hook context; skip reflection`); return; }

      const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
      const currentSessionId = typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
      let currentSessionFile = typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;
      const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
      const commandSource = typeof context.commandSource === "string" ? context.commandSource : "";
      api.logger.info(`memory-reflection: command:${action} hook start; sessionKey=${sessionKey || "(none)"}; source=${commandSource || "(unknown)"}; sessionId=${currentSessionId}; sessionFile=${currentSessionFile || "(none)"}`);

      if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
        const searchDirs = resolveReflectionSessionSearchDirs({ context, cfg, workspaceDir, currentSessionFile, sourceAgentId });
        api.logger.info(`memory-reflection: command:${action} session recovery start for session ${currentSessionId}; initial=${currentSessionFile || "(none)"}; dirs=${searchDirs.join(" | ") || "(none)"}`);
        for (const sessionsDir of searchDirs) {
          const recovered = await findPreviousSessionFile(sessionsDir, currentSessionFile, currentSessionId);
          if (recovered) { api.logger.info(`memory-reflection: command:${action} recovered session file ${recovered} from ${sessionsDir}`); currentSessionFile = recovered; break; }
        }
      }

      if (!currentSessionFile) {
        const searchDirs = resolveReflectionSessionSearchDirs({ context, cfg, workspaceDir, currentSessionFile, sourceAgentId });
        api.logger.warn(`memory-reflection: command:${action} missing session file after recovery for session ${currentSessionId}; dirs=${searchDirs.join(" | ") || "(none)"}`);
        return;
      }

      const conversation = await readSessionConversationWithResetFallback(currentSessionFile, reflectionMessageCount);
      if (!conversation) { api.logger.warn(`memory-reflection: command:${action} conversation empty/unusable for session ${currentSessionId}; file=${currentSessionFile}`); return; }

      reflectionRan = true;

      const now = new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now());
      const nowTs = now.getTime();
      const dateStr = now.toISOString().split("T")[0];
      const timeIso = now.toISOString().split("T")[1].replace("Z", "");
      const timeHms = timeIso.split(".")[0];
      const timeCompact = timeIso.replace(/[:.]/g, "");
      const reflectionRunAgentId = resolveReflectionRunAgentId(cfg, sourceAgentId);
      const targetScope = isSystemBypassId(sourceAgentId) ? config.scopes?.default ?? "global" : scopeManager.getDefaultScope(sourceAgentId);
      const toolErrorSignals = sessionKey ? (reflectionErrorStateBySession.get(sessionKey)?.entries ?? []).slice(-reflectionErrorReminderMaxEntries) : [];

      api.logger.info(`memory-reflection: command:${action} reflection generation start for session ${currentSessionId}; timeoutMs=${reflectionTimeoutMs}`);
      const reflectionGenerated = await generateReflectionText({
        conversation, maxInputChars: reflectionMaxInputChars, cfg, agentId: reflectionRunAgentId,
        workspaceDir, timeoutMs: reflectionTimeoutMs, thinkLevel: reflectionThinkLevel,
        toolErrorSignals, runEmbeddedPiAgent: resolveRuntimeEmbeddedPiRunner(api), logger: api.logger,
      });
      api.logger.info(`memory-reflection: command:${action} reflection generation done for session ${currentSessionId}; runner=${reflectionGenerated.runner}; usedFallback=${reflectionGenerated.usedFallback ? "yes" : "no"}`);
      const reflectionText = reflectionGenerated.text;
      if (reflectionGenerated.runner === "cli") {
        api.logger.warn(`memory-reflection: embedded runner unavailable, used openclaw CLI fallback for session ${currentSessionId}${reflectionGenerated.error ? ` (${reflectionGenerated.error})` : ""}`);
      } else if (reflectionGenerated.usedFallback) {
        api.logger.warn(`memory-reflection: fallback used for session ${currentSessionId}${reflectionGenerated.error ? ` (${reflectionGenerated.error})` : ""}`);
      }

      const header = [`# Reflection: ${dateStr} ${timeHms} UTC`, "", `- Session Key: ${sessionKey}`, `- Session ID: ${currentSessionId || "unknown"}`, `- Command: ${String(event.action || "unknown")}`, `- Error Signatures: ${toolErrorSignals.length ? toolErrorSignals.map((s) => s.signatureHash).join(", ") : "(none)"}`, ""].join("\n");
      const reflectionBody = `${header}${reflectionText.trim()}\n`;

      const outDir = join(workspaceDir, "memory", "reflections", dateStr);
      await mkdir(outDir, { recursive: true });
      const agentToken = sanitizeFileToken(sourceAgentId, "agent");
      const sessionToken = sanitizeFileToken(currentSessionId || "unknown", "session");
      let relPath = "";
      let writeOk = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `${timeCompact}-${agentToken}-${sessionToken}${suffix}.md`;
        const candidateRelPath = join("memory", "reflections", dateStr, fileName);
        const candidateOutPath = join(workspaceDir, candidateRelPath);
        try { await writeFile(candidateOutPath, reflectionBody, { encoding: "utf-8", flag: "wx" }); relPath = candidateRelPath; writeOk = true; break; } catch (err: any) { if (err?.code === "EEXIST") continue; throw err; }
      }
      if (!writeOk) throw new Error(`Failed to allocate unique reflection file for ${dateStr} ${timeCompact}`);

      const reflectionGovernanceCandidates = extractReflectionLearningGovernanceCandidates(reflectionText);
      if (config.selfImprovement?.enabled !== false && reflectionGovernanceCandidates.length > 0) {
        for (const candidate of reflectionGovernanceCandidates) {
          await appendSelfImprovementEntry({
            baseDir: workspaceDir, type: "learning", summary: candidate.summary, details: candidate.details,
            suggestedAction: candidate.suggestedAction, category: "best_practice", area: candidate.area || "config",
            priority: candidate.priority || "medium", status: candidate.status || "pending", source: `mymem/reflection:${relPath}`,
          });
        }
        if (singletonState?.feedbackLoop) {
          for (const signal of toolErrorSignals) {
            singletonState.feedbackLoop.onPreventiveLessonEvidence({
              summary: signal.summary,
              source: signal.source,
              sessionKey,
              scope: targetScope,
              scopeFilter: [targetScope],
              toolName: signal.toolName,
              signatureHash: signal.signatureHash,
            });
          }
          singletonState.feedbackLoop.drainPreventiveLessonBuffer().catch(() => {});
          singletonState.feedbackLoop.scanErrorFile(workspaceDir).catch(() => {});
          singletonState.feedbackLoop.forceAdaptationCycle(resolvedDbPath, normalizeAdmissionControlConfig(config.admissionControl)).catch(() => {});
        }
      }

      const reflectionEventId = createReflectionEventId({ runAt: nowTs, sessionKey, sessionId: currentSessionId || "unknown", agentId: sourceAgentId, command: String(event.action || "unknown") });

      const mappedReflectionMemories = extractInjectableReflectionMappedMemoryItems(reflectionText);
      for (const mapped of mappedReflectionMemories) {
        const vector = await embedder.embedPassage(mapped.text);
        let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
        try { existing = await store.vectorSearch(vector, 1, 0.1, [targetScope]); } catch (err) { api.logger.warn(`memory-reflection: mapped memory duplicate pre-check failed, continue store: ${String(err)}`); }
        if (existing.length > 0 && existing[0].score > 0.95) continue;

        const importance = mapped.category === "decision" ? 0.85 : 0.8;
        const metadata = JSON.stringify(buildReflectionMappedMetadata({
          mappedItem: mapped, eventId: reflectionEventId, agentId: sourceAgentId, sessionKey,
          sessionId: currentSessionId || "unknown", runAt: nowTs, usedFallback: reflectionGenerated.usedFallback,
          toolErrorSignals, sourceReflectionPath: relPath,
        }));

        const storedEntry = await store.store({ text: mapped.text, vector, importance, category: mapped.category, scope: targetScope, metadata });
        if (mdMirror) {
          await mdMirror({ text: mapped.text, category: mapped.category, scope: targetScope, timestamp: storedEntry.timestamp }, { source: `reflection:${mapped.heading}`, agentId: sourceAgentId });
        }
      }

      if (reflectionStoreToLanceDB) {
        const stored = await storeReflectionToLanceDB({
          reflectionText, sessionKey, sessionId: currentSessionId || "unknown", agentId: sourceAgentId,
          command: String(event.action || "unknown"), scope: targetScope, toolErrorSignals, runAt: nowTs,
          usedFallback: reflectionGenerated.usedFallback, eventId: reflectionEventId, sourceReflectionPath: relPath,
          writeLegacyCombined: reflectionWriteLegacyCombined,
          embedPassage: (text) => embedder.embedPassage(text),
          vectorSearch: (vector, limit, minScore, scopeFilter) => store.vectorSearch(vector, limit, minScore, scopeFilter),
          store: (entry) => store.store(entry),
        });
        if (sessionKey && stored.slices.derived.length > 0) {
          reflectionDerivedBySession.set(sessionKey, { updatedAt: nowTs, derived: stored.slices.derived });
        }
        for (const cacheKey of reflectionByAgentCache.keys()) {
          if (cacheKey.startsWith(`${sourceAgentId}::`)) reflectionByAgentCache.delete(cacheKey);
        }
      } else if (sessionKey && reflectionGenerated.usedFallback) {
        reflectionDerivedBySession.delete(sessionKey);
      }

      const dailyPath = join(workspaceDir, "memory", `${dateStr}.md`);
      await ensureDailyLogFile(dailyPath, dateStr);
      await appendFile(dailyPath, `- [${timeHms} UTC] Reflection generated: \`${relPath}\`\n`, "utf-8");
      api.logger.info(`memory-reflection: wrote ${relPath} for session ${currentSessionId}`);
    } catch (err) {
      api.logger.warn(`memory-reflection: hook failed: ${String(err)}`);
    } finally {
      if (sessionKey) {
        reflectionErrorStateBySession.delete(sessionKey);
        getGlobalReflectionLock().delete(sessionKey);
        if (reflectionRan) getSerialGuardMap().set(sessionKey, Date.now());
      }
      helpers.pruneReflectionSessionState();
    }
  };

  api.registerHook?.("command:new", runMemoryReflection, { name: "mymem.memory-reflection.command-new", description: "Generate reflection log before /new" });
  api.registerHook?.("command:reset", runMemoryReflection, { name: "mymem.memory-reflection.command-reset", description: "Generate reflection log before /reset" });
  (isCliMode() ? api.logger.debug : api.logger.info)("memory-reflection: integrated hooks registered (command:new, command:reset, after_tool_call, before_prompt_build, session_end)");
}
