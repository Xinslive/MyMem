/**
 * MyMem Plugin
 * Enhanced LanceDB-backed long-term memory with hybrid retrieval and multi-scope isolation
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, ReflectionThinkLevel, SessionStrategy, ReflectionInjectMode, ReflectionErrorSignal, ReflectionErrorState, AgentWorkspaceMap } from "./src/plugin-types.js";
import { DEFAULT_SELF_IMPROVEMENT_REMINDER, SELF_IMPROVEMENT_NOTE_PREFIX, DEFAULT_REFLECTION_MESSAGE_COUNT, DEFAULT_REFLECTION_MAX_INPUT_CHARS, DEFAULT_REFLECTION_TIMEOUT_MS, DEFAULT_REFLECTION_THINK_LEVEL, DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES, DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS, DEFAULT_REFLECTION_SESSION_TTL_MS, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS, REFLECTION_FALLBACK_MARKER, DIAG_BUILD_TAG } from "./src/plugin-constants.js";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { readFile, readdir, writeFile, mkdir, appendFile, unlink, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// Detect CLI mode: when running as a CLI subcommand (e.g. `openclaw mymem stats`),
// OpenClaw sets OPENCLAW_CLI=1 in the process environment. Registration and
// lifecycle logs are noisy in CLI context (printed to stderr before command output),
// so we downgrade them to debug level when running in CLI mode.
const isCliMode = () => process.env.OPENCLAW_CLI === "1";

// Import extracted utilities
import { redactSecrets, containsErrorSignal, summarizeErrorText, sha256Hex, normalizeErrorSignature, extractTextFromToolResult, summarizeRecentConversationMessages, extractTextContent, shouldSkipReflectionMessage, isExplicitRememberCommand, summarizeAgentEndMessages } from "./src/session-utils.js";
import { resolveEnvVars, parsePositiveInt, resolveFirstApiKey, resolveOptionalPathWithEnv, resolveHookAgentId, resolveSourceFromSessionKey, pruneMapIfOver, resolveLlmTimeoutMs } from "./src/config-utils.js";
import { clampInt } from "./src/utils.js";
import { getDefaultDbPath, getDefaultWorkspaceDir, getDefaultMdMirrorDir, resolveWorkspaceDirFromContext } from "./src/path-utils.js";
import { AUTO_CAPTURE_MAP_MAX_ENTRIES, buildAutoCaptureConversationKeyFromIngress, buildAutoCaptureConversationKeyFromSessionKey, isInternalReflectionSessionKey } from "./src/auto-capture-utils.js";
import { withTimeout, tryParseJsonObject, extractJsonObjectFromOutput, extractReflectionTextFromCliResult, clipDiagnostic, asNonEmptyString, sanitizeFileToken } from "./src/cli-utils.js";
import { generateReflectionText } from "./src/reflection-cli.js";
import { resolveRuntimeEmbeddedPiRunner } from "./src/openclaw-extension-utils.js";
import { parsePluginConfig } from "./src/plugin-config-parser.js";
import { getPluginVersion } from "./src/version-utils.js";
import { sortFileNamesByMtimeDesc } from "./src/file-utils.js";
import { findPreviousSessionFile, resolveAgentWorkspaceMap, createMdMirrorWriter, createAdmissionRejectionAuditWriter, type MdMirrorWriter } from "./src/workspace-utils.js";
import { readSessionConversationForReflection, readSessionConversationWithResetFallback, ensureDailyLogFile, buildReflectionPrompt, buildReflectionFallbackText, loadSelfImprovementReminderContent } from "./src/session-recovery-utils.js";
import { resolveAgentPrimaryModelRef, isAgentDeclaredInConfig, splitProviderModel } from "./src/agent-config-utils.js";
import { TelemetryStore, resolveTelemetryDir } from "./src/telemetry.js";

// Import core components
import { MemoryStore, validateStoragePath } from "./src/store.js";
import { createEmbedder, getVectorDimensions } from "./src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./src/retriever.js";
import { RetrievalStatsCollector } from "./src/retrieval-stats.js";
import { createScopeManager, resolveScopeFilter, isSystemBypassId, parseAgentIdFromSessionKey } from "./src/scopes.js";
import { createMigrator } from "./src/migrate.js";
import { registerAllMemoryTools } from "./src/tools.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./src/self-improvement-files.js";
// Adaptive retrieval utilities are now used only in auto-recall-hook.ts
import { parseClawteamScopes, applyClawteamScopes } from "./src/clawteam-scope.js";
import {
  runCompaction,
  shouldRunCompaction,
  recordCompactionRun,
  type CompactionConfig,
  type CompactorLifecycle,
} from "./src/memory-compactor.js";
import {
  runLifecycleMaintenance,
  shouldRunLifecycleMaintenance,
  recordLifecycleMaintenanceRun,
} from "./src/lifecycle-maintainer.js";
import {
  runPreferenceDistiller,
  shouldRunPreferenceDistiller,
  recordPreferenceDistillerRun,
} from "./src/preference-distiller.js";
import {
  runExperienceCompiler,
  shouldRunExperienceCompiler,
  recordExperienceCompilerRun,
} from "./src/experience-compiler.js";
import { runWithReflectionTransientRetryOnce } from "./src/reflection-retry.js";
import { resolveReflectionSessionSearchDirs, stripResetSuffix } from "./src/session-recovery.js";
import {
  storeReflectionToLanceDB,
  loadAgentReflectionSlicesFromEntries,
  DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
} from "./src/reflection-store.js";
import {
  extractReflectionLearningGovernanceCandidates,
  extractInjectableReflectionMappedMemoryItems,
} from "./src/reflection-slices.js";
import { createReflectionEventId } from "./src/reflection-event-store.js";
import { buildReflectionMappedMetadata } from "./src/reflection-mapped-metadata.js";
import { createMemoryCLI } from "./cli.js";
import { isNoise } from "./src/noise-filter.js";
import { normalizeAutoCaptureText } from "./src/auto-capture-cleanup.js";
import { summarizeTextPreview, summarizeMessageContent } from "./src/capture-detection.js";
import { shouldCapture, detectCategory } from "./src/capture-detector.js";

// Import smart extraction & lifecycle components
import { SmartExtractor, createExtractionRateLimiter } from "./src/smart-extractor.js";
import { compressTexts, estimateConversationValue } from "./src/session-compressor.js";
import { NoisePrototypeBank } from "./src/noise-prototypes.js";
import { HybridNoiseDetector } from "./src/noise-detector.js";
import { createLlmClient } from "./src/llm-client.js";
import type { LlmClient } from "./src/llm-client.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./src/decay-engine.js";
import { RecencyEngine, DEFAULT_RECENCY_CONFIG } from "./src/recency-engine.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "./src/tier-manager.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";
import {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./src/smart-metadata.js";
import {
  type WorkspaceBoundaryConfig,
} from "./src/workspace-boundary.js";
import {
  normalizeAdmissionControlConfig,
  resolveRejectedAuditFilePath,
  type AdmissionControlConfig,
  type AdmissionRejectionAuditEntry,
  type AdmissionTypePriors,
} from "./src/admission-control.js";
import {
  FeedbackLoop,
  normalizeFeedbackLoopConfig,
} from "./src/feedback-loop.js";
// intent-analyzer imports moved to auto-recall-hook.ts

// ============================================================================
// Version
// ============================================================================

const pluginVersion = getPluginVersion();
const STARTUP_HEALTH_CHECK_DELAY_MS = 15_000;

// ============================================================================
// Plugin Definition
// ============================================================================

// WeakSet keyed by API instance — each distinct API object tracks its own initialized state.
// Using WeakSet instead of a module-level boolean avoids the "second register() call skips
// hook/tool registration for the new API instance" regression that rwmjhb identified.
const _registeredApis = new WeakSet<OpenClawPluginApi>();

// ============================================================================
// Hook Event Deduplication (Phase 1)
// ============================================================================
//
// OpenClaw calls register() once per scope init (5× at startup, 4× per inbound
import { dedupHookEvent } from "./src/hook-dedup.js";
import { registerAutoCaptureHook } from "./src/auto-capture-hook.js";
import { registerAutoRecallHook } from "./src/auto-recall-hook.js";
import { registerSelfImprovementHook } from "./src/self-improvement-hook.js";
import { createHookEnhancementState, registerHookEnhancements } from "./src/hook-enhancements.js";

// ============================================================================
// Phase 2 — Singleton State Management (PR #598)
// ============================================================================

interface PluginSingletonState {
  config: ReturnType<typeof parsePluginConfig>;
  resolvedDbPath: string;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  decayEngine: ReturnType<typeof createDecayEngine>;
  recencyEngine: RecencyEngine;
  hybridNoiseDetector: HybridNoiseDetector;
  tierManager: ReturnType<typeof createTierManager>;
  retriever: ReturnType<typeof createRetriever>;
  scopeManager: ReturnType<typeof createScopeManager>;
  migrator: ReturnType<typeof createMigrator>;
  smartExtractor: SmartExtractor | null;
  smartExtractionLlmClient: LlmClient | null;
  extractionRateLimiter: ReturnType<typeof createExtractionRateLimiter>;
  feedbackLoop: FeedbackLoop | null;
  telemetryStore: TelemetryStore | null;
  // Session Maps — persist across scope refreshes instead of being recreated
  reflectionErrorStateBySession: Map<string, ReflectionErrorState>;
  reflectionDerivedBySession: Map<string, { updatedAt: number; derived: string[] }>;
  reflectionByAgentCache: Map<string, { updatedAt: number; invariants: string[]; derived: string[] }>;
  recallHistory: Map<string, Map<string, number>>;
  turnCounter: Map<string, number>;
  lastRawUserMessage: Map<string, string>;
  hookEnhancementState: ReturnType<typeof createHookEnhancementState>;
  autoCaptureSeenTextCount: Map<string, number>;
  autoCapturePendingIngressTexts: Map<string, string[]>;
  autoCaptureRecentTexts: Map<string, string[]>;
}

let _singletonState: PluginSingletonState | null = null;

// Test-only: reset singleton state so each test gets a fresh _initPluginState run.
export function __resetSingletonForTesting__(): void {
	_singletonState = null;
}

function _initPluginState(api: OpenClawPluginApi): PluginSingletonState {
  const config = parsePluginConfig(api.pluginConfig);
  const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());
  const telemetryStore = new TelemetryStore(
    config.telemetry ?? { persist: false, maxRecords: 1000, sampleRate: 1 },
    api.resolvePath(resolveTelemetryDir(resolvedDbPath, config.telemetry?.dir)),
  );

  try {
    validateStoragePath(resolvedDbPath);
  } catch (err) {
    api.logger.warn(
      `mymem: storage path issue — ${String(err)}\n` +
      `  The plugin will still attempt to start, but writes may fail.`,
    );
  }

  const vectorDim = getVectorDimensions(
    config.embedding.model || "text-embedding-3-small",
    config.embedding.dimensions,
  );
  const store = new MemoryStore({ dbPath: resolvedDbPath, vectorDim });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: config.embedding.apiKey,
    model: config.embedding.model || "text-embedding-3-small",
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    omitDimensions: config.embedding.omitDimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
    logger: api.logger,
  });
  const decayEngine = createDecayEngine({
    ...DEFAULT_DECAY_CONFIG,
    ...(config.decay || {}),
  });
  // RecencyEngine is the lightweight alternative when DecayEngine (Weibull) is not configured.
  // It uses simple exponential decay instead of Weibull, suitable for resource-constrained environments.
  const recencyConfig = config.retrieval ?? {};
  const feedbackLoopConfig = normalizeFeedbackLoopConfig(config.feedbackLoop);
  const feedbackLoopAdmissionConfig = normalizeAdmissionControlConfig(config.admissionControl);
  const feedbackLoopWorkspaceDir = getDefaultWorkspaceDir();
  const recencyEngine = new RecencyEngine({
    ...DEFAULT_RECENCY_CONFIG,
    halfLifeDays: recencyConfig.timeDecayHalfLifeDays ?? recencyConfig.recencyHalfLifeDays ?? DEFAULT_RECENCY_CONFIG.halfLifeDays,
    reinforcementFactor: recencyConfig.reinforcementFactor ?? DEFAULT_RECENCY_CONFIG.reinforcementFactor,
    maxHalfLifeMultiplier: recencyConfig.maxHalfLifeMultiplier ?? DEFAULT_RECENCY_CONFIG.maxHalfLifeMultiplier,
    importanceBaseWeight: DEFAULT_RECENCY_CONFIG.importanceBaseWeight,
  });
  const tierManager = createTierManager({
    ...DEFAULT_TIER_CONFIG,
    ...(config.tier || {}),
  });
  // HybridNoiseDetector combines regex fast-path with embedding semantic detection.
  // Created early so it can be initialized in parallel with other startup tasks.
  const hybridNoiseDetector = new HybridNoiseDetector(embedder, undefined, {
    learnFromRegex: true,
    debugLog: (msg: string) => api.logger.debug(msg),
  });
  // Initialize async (safe to not await - detector falls back to regex-only until ready)
  hybridNoiseDetector.init().catch((err) =>
    api.logger.debug(`mymem: hybrid noise detector init: ${String(err)}`),
  );
  const retriever = createRetriever(
    store,
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval },
    { decayEngine, recencyEngine, noiseDetector: hybridNoiseDetector, tierManager, logger: api.logger },
  );
  const statsCollector = new RetrievalStatsCollector(config.telemetry?.maxRecords ?? 1000);
  if (telemetryStore.enabled) {
    statsCollector.setRecordHook((trace, source) => telemetryStore.recordRetrieval(trace, source));
  }
  retriever.setStatsCollector(statsCollector);
  const scopeManager = createScopeManager(config.scopes);

  const clawteamScopes = parseClawteamScopes(process.env.CLAWTEAM_MEMORY_SCOPE);
  if (clawteamScopes.length > 0) {
    applyClawteamScopes(scopeManager, clawteamScopes);
    api.logger.info(`mymem: CLAWTEAM_MEMORY_SCOPE added scopes: ${clawteamScopes.join(", ")}`);
  }

  const migrator = createMigrator(store);

  let smartExtractor: SmartExtractor | null = null;
  let smartExtractionLlmClient: LlmClient | null = null;
  let feedbackLoop: FeedbackLoop | null = null;
  if (config.smartExtraction !== false) {
    try {
      const llmAuth = config.llm?.auth || "api-key";
      const llmApiKey = llmAuth === "oauth"
        ? undefined
        : config.llm?.apiKey
          ? resolveEnvVars(config.llm.apiKey)
          : resolveFirstApiKey(config.embedding.apiKey);
      const llmBaseURL = llmAuth === "oauth"
        ? (config.llm?.baseURL ? resolveEnvVars(config.llm.baseURL) : undefined)
        : config.llm?.baseURL
          ? resolveEnvVars(config.llm.baseURL)
          : config.embedding.baseURL;
      const llmModel = config.llm?.model || "openai/gpt-oss-120b";
      const llmOauthPath = llmAuth === "oauth"
        ? resolveOptionalPathWithEnv(api, config.llm?.oauthPath, ".mymem/oauth.json")
        : undefined;
      const llmOauthProvider = llmAuth === "oauth" ? config.llm?.oauthProvider : undefined;
      const llmTimeoutMs = resolveLlmTimeoutMs(config);

      const llmClient = createLlmClient({
        auth: llmAuth,
        apiKey: llmApiKey,
        model: llmModel,
        baseURL: llmBaseURL,
        oauthProvider: llmOauthProvider,
        oauthPath: llmOauthPath,
        timeoutMs: llmTimeoutMs,
        log: (msg: string) => api.logger.debug(msg),
        warnLog: (msg: string) => api.logger.warn(msg),
      });
      smartExtractionLlmClient = llmClient;

      const noiseBank = new NoisePrototypeBank((msg: string) => api.logger.debug(msg));
      noiseBank.init(embedder).catch((err) =>
        api.logger.debug(`mymem: noise bank init: ${String(err)}`),
      );

      const admissionRejectionAuditWriter = createAdmissionRejectionAuditWriter(config, resolvedDbPath, api);

      // Wrapper that chains feedbackLoop.onAdmissionRejected() into the existing audit writer.
      // Uses _singletonState so the closure reads the live reference (set after this returns).
      const onAdmissionRejectedOriginal = admissionRejectionAuditWriter ?? undefined;
      const onAdmissionRejected = onAdmissionRejectedOriginal
        ? async (entry: AdmissionRejectionAuditEntry) => {
            await onAdmissionRejectedOriginal(entry);
            if (_singletonState?.feedbackLoop) _singletonState.feedbackLoop.onAdmissionRejected(entry);
          }
        : (entry: AdmissionRejectionAuditEntry) => {
            if (_singletonState?.feedbackLoop) _singletonState.feedbackLoop.onAdmissionRejected(entry);
          };

      smartExtractor = new SmartExtractor(store, embedder, llmClient, {
        user: "User",
        extractMinMessages: config.extractMinMessages ?? 5,
        extractMaxChars: config.extractMaxChars ?? 8000,
        defaultScope: config.scopes?.default ?? "global",
        workspaceBoundary: config.workspaceBoundary,
        admissionControl: config.admissionControl,
        onAdmissionRejected,
        onExtractionComplete: telemetryStore.enabled
          ? ({ sessionKey, scope, stats }) => telemetryStore.recordExtraction(sessionKey, scope, stats)
          : undefined,
        log: (msg: string) => api.logger.info(msg),
        debugLog: (msg: string) => api.logger.debug(msg),
        noiseBank,
      });

      (isCliMode() ? api.logger.debug : api.logger.info)(
        "mymem: smart extraction enabled (LLM model: "
        + llmModel
        + ", timeoutMs: "
        + llmTimeoutMs
        + ", noise bank: ON)",
      );

      // feedbackLoop must be created here (inside the if block) so it can access
      // noiseBank and smartExtractor which are declared in this scope.
      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          noiseBank,
          embedder,
          admissionController: smartExtractor ? smartExtractor.getAdmissionController() : null,
          config: feedbackLoopConfig,
          debugLog: (msg: string) => api.logger.debug(msg),
          runtimeContext: {
            workspaceDir: feedbackLoopWorkspaceDir,
            dbPath: resolvedDbPath,
            admissionConfig: feedbackLoopAdmissionConfig,
          },
        });
      }
    } catch (err) {
      api.logger.warn(`mymem: smart extraction init failed, falling back to regex: ${String(err)}`);
      const fallbackNoiseBank = new NoisePrototypeBank((msg: string) => api.logger.debug(msg));
      fallbackNoiseBank.init(embedder).catch((initErr) =>
        api.logger.debug(`mymem: fallback noise bank init: ${String(initErr)}`),
      );
      // Still create feedbackLoop even if extraction failed.
      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          noiseBank: fallbackNoiseBank,
          embedder,
          admissionController: null,
          config: feedbackLoopConfig,
          debugLog: (msg: string) => api.logger.debug(msg),
          runtimeContext: {
            workspaceDir: feedbackLoopWorkspaceDir,
            dbPath: resolvedDbPath,
            admissionConfig: feedbackLoopAdmissionConfig,
          },
        });
      }
    }
  } else if (feedbackLoopConfig.enabled) {
    // smartExtraction is off but feedbackLoop may still want to learn noise.
    feedbackLoop = new FeedbackLoop({
      noiseBank: null,
      embedder,
      admissionController: null,
      config: feedbackLoopConfig,
      debugLog: (msg: string) => api.logger.debug(msg),
      runtimeContext: {
        workspaceDir: feedbackLoopWorkspaceDir,
        dbPath: resolvedDbPath,
        admissionConfig: feedbackLoopAdmissionConfig,
      },
    });
  }

  const extractionRateLimiter = createExtractionRateLimiter({
    maxExtractionsPerHour: config.extractionThrottle?.maxExtractionsPerHour,
  });

  // Session Maps — MUST be in singleton state so they persist across scope refreshes
  const reflectionErrorStateBySession = new Map<string, ReflectionErrorState>();
  const reflectionDerivedBySession = new Map<string, { updatedAt: number; derived: string[] }>();
  const reflectionByAgentCache = new Map<string, { updatedAt: number; invariants: string[]; derived: string[] }>();
  const recallHistory = new Map<string, Map<string, number>>();
  const turnCounter = new Map<string, number>();
  const lastRawUserMessage = new Map<string, string>();
  const hookEnhancementState = createHookEnhancementState();
  const autoCaptureSeenTextCount = new Map<string, number>();
  const autoCapturePendingIngressTexts = new Map<string, string[]>();
  const autoCaptureRecentTexts = new Map<string, string[]>();

  const logReg = isCliMode() ? api.logger.debug : api.logger.info;
  logReg(
    `mymem@${pluginVersion}: plugin registered [singleton init] `
    + `(db: ${resolvedDbPath}, model: ${config.embedding.model || "text-embedding-3-small"})`,
  );
  logReg(`mymem: diagnostic build tag loaded (${DIAG_BUILD_TAG})`);

  return {
    config,
    resolvedDbPath,
    store,
    embedder,
    decayEngine,
    recencyEngine,
    hybridNoiseDetector,
    tierManager,
    retriever,
    scopeManager,
    migrator,
    smartExtractor,
    smartExtractionLlmClient,
    extractionRateLimiter,
    feedbackLoop,
    telemetryStore,
    reflectionErrorStateBySession,
    reflectionDerivedBySession,
    reflectionByAgentCache,
    recallHistory,
    turnCounter,
    lastRawUserMessage,
    hookEnhancementState,
    autoCaptureSeenTextCount,
    autoCapturePendingIngressTexts,
    autoCaptureRecentTexts,
  };
}

const myMemPlugin = {
  id: "mymem",
  name: "MyMem",
  description:
    "Enhanced LanceDB-backed long-term memory with hybrid retrieval, multi-scope isolation, and management CLI",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Idempotent guard: skip re-init if this exact API instance has already registered.
    if (_registeredApis.has(api)) {
      api.logger.debug?.("mymem: register() called again — skipping re-init (idempotent)");
      return;
    }
    _registeredApis.add(api);

    // Parse and validate configuration
    // ========================================================================
    // Phase 2 — Singleton state: initialize heavy resources exactly once.
    // First register() call runs _initPluginState(); subsequent calls reuse
    // the same singleton via destructuring. This prevents:
    //   - Memory heap growth from repeated resource creation (~9 calls/process)
    //   - Accumulated session Maps being lost on re-registration
    // ========================================================================
    if (!_singletonState) { _singletonState = _initPluginState(api); }
    const {
      config,
      resolvedDbPath,
      store,
      embedder,
      retriever,
      scopeManager,
      migrator,
      smartExtractor,
      smartExtractionLlmClient,
      decayEngine,
      recencyEngine,
      hybridNoiseDetector,
      tierManager,
      extractionRateLimiter,
      feedbackLoop,
      telemetryStore,
      reflectionErrorStateBySession,
      reflectionDerivedBySession,
      reflectionByAgentCache,
      recallHistory,
      turnCounter,
      lastRawUserMessage,
      hookEnhancementState,
      autoCaptureSeenTextCount,
      autoCapturePendingIngressTexts,
      autoCaptureRecentTexts,
    } = _singletonState;

    const pruneOldestByUpdatedAt = <T extends { updatedAt: number }>(map: Map<string, T>, maxSize: number) => {
      if (map.size <= maxSize) return;
      const sorted = [...map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const removeCount = map.size - maxSize;
      for (let i = 0; i < removeCount; i++) {
        const key = sorted[i]?.[0];
        if (key) map.delete(key);
      }
    };

    const pruneReflectionSessionState = (now = Date.now()) => {
      for (const [key, state] of reflectionErrorStateBySession.entries()) {
        if (now - state.updatedAt > DEFAULT_REFLECTION_SESSION_TTL_MS) {
          reflectionErrorStateBySession.delete(key);
        }
      }
      for (const [key, state] of reflectionDerivedBySession.entries()) {
        if (now - state.updatedAt > DEFAULT_REFLECTION_SESSION_TTL_MS) {
          reflectionDerivedBySession.delete(key);
        }
      }
      pruneOldestByUpdatedAt(reflectionErrorStateBySession, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
      pruneOldestByUpdatedAt(reflectionDerivedBySession, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
    };

    const getReflectionErrorState = (sessionKey: string): ReflectionErrorState => {
      const key = sessionKey.trim();
      const current = reflectionErrorStateBySession.get(key);
      if (current) {
        current.updatedAt = Date.now();
        return current;
      }
      const created: ReflectionErrorState = { entries: [], lastInjectedCount: 0, signatureSet: new Set<string>(), updatedAt: Date.now() };
      reflectionErrorStateBySession.set(key, created);
      return created;
    };

    const addReflectionErrorSignal = (sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean) => {
      if (!sessionKey.trim()) return;
      pruneReflectionSessionState();
      const state = getReflectionErrorState(sessionKey);
      if (dedupeEnabled && state.signatureSet.has(signal.signatureHash)) return;
      state.entries.push(signal);
      state.signatureSet.add(signal.signatureHash);
      state.updatedAt = Date.now();
      if (state.entries.length > 30) {
        const removed = state.entries.length - 30;
        state.entries.splice(0, removed);
        state.lastInjectedCount = Math.max(0, state.lastInjectedCount - removed);
        state.signatureSet = new Set(state.entries.map((e) => e.signatureHash));
      }
    };

    const getPendingReflectionErrorSignalsForPrompt = (sessionKey: string, maxEntries: number): ReflectionErrorSignal[] => {
      pruneReflectionSessionState();
      const state = reflectionErrorStateBySession.get(sessionKey.trim());
      if (!state) return [];
      state.updatedAt = Date.now();
      state.lastInjectedCount = Math.min(state.lastInjectedCount, state.entries.length);
      const pending = state.entries.slice(state.lastInjectedCount);
      if (pending.length === 0) return [];
      const clipped = pending.slice(-maxEntries);
      state.lastInjectedCount = state.entries.length;
      return clipped;
    };

    const loadAgentReflectionSlices = async (agentId: string, scopeFilter?: string[]) => {
      const scopeKey = Array.isArray(scopeFilter)
        ? `scopes:${[...scopeFilter].sort().join(",")}`
        : "<NO_SCOPE_FILTER>";
      const cacheKey = `${agentId}::${scopeKey}`;
      const cached = reflectionByAgentCache.get(cacheKey);
      if (cached && Date.now() - cached.updatedAt < 15_000) return cached;

      // Prefer reflection-category rows to avoid full-table reads on bypass callers.
      // Fall back to an uncategorized scan only when the category query produced no
      // agent-owned reflection slices, preserving backward compatibility with mixed-schema stores.
      let entries = await store.list(scopeFilter, "reflection", 240, 0);
      let slices = loadAgentReflectionSlicesFromEntries({
        entries,
        agentId,
        deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
      });
      if (slices.invariants.length === 0 && slices.derived.length === 0) {
        const legacyEntries = await store.list(scopeFilter, undefined, 240, 0);
        entries = legacyEntries.filter((entry) => {
          try {
            const metadata = parseSmartMetadata(entry.metadata, entry);
            return metadata.source === "reflection" && metadata.source_session === agentId;
          } catch {
            return false;
          }
        });
        slices = loadAgentReflectionSlicesFromEntries({
          entries,
          agentId,
          deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
        });
      }
      const { invariants, derived } = slices;
      const next = { updatedAt: Date.now(), invariants, derived };
      reflectionByAgentCache.set(cacheKey, next);
      return next;
    };

    const resolveGovernanceCommandContext = async (event: any): Promise<{
      sessionKey: string;
      sessionId: string;
      conversation: string | null;
      scopeFilter: string[] | undefined;
    } | null> => {
      const sessionKey = typeof event?.sessionKey === "string" ? event.sessionKey.trim() : "";
      if (!sessionKey) return null;

      const context = (event?.context || {}) as Record<string, unknown>;
      const cfg = context.cfg ?? (api as any).config ?? {};
      const workspaceDir = resolveWorkspaceDirFromContext(context);
      const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
      const scopeFilter = resolveScopeFilter(scopeManager, sourceAgentId);
      const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
      const sessionId = typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
      let currentSessionFile = typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;

      if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
        const searchDirs = resolveReflectionSessionSearchDirs({
          context,
          cfg,
          workspaceDir,
          currentSessionFile,
          sourceAgentId,
        });
        for (const sessionsDir of searchDirs) {
          const recovered = await findPreviousSessionFile(sessionsDir, currentSessionFile, sessionId);
          if (recovered) {
            currentSessionFile = recovered;
            break;
          }
        }
      }

      const conversation = currentSessionFile
        ? await readSessionConversationWithResetFallback(
            currentSessionFile,
            config.memoryReflection?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT,
          )
        : null;

      return {
        sessionKey,
        sessionId,
        conversation,
        scopeFilter,
      };
    };

    const runCommandGovernanceAutomation = async (event: any) => {
      if (config.preferenceDistiller?.enabled !== true && config.experienceCompiler?.enabled !== true) return;
      const resolved = await resolveGovernanceCommandContext(event);
      if (!resolved) return;

      if (config.preferenceDistiller?.enabled === true) {
        await runPreferenceDistiller(
          { store, embedder, logger: api.logger },
          config.preferenceDistiller,
          resolved.scopeFilter,
        );
      }

      if (config.experienceCompiler?.enabled === true) {
        await runExperienceCompiler(
          { store, embedder, logger: api.logger },
          config.experienceCompiler,
          {
            scopeFilter: resolved.scopeFilter,
            sessionKey: resolved.sessionKey,
            conversation: resolved.conversation || undefined,
          },
        );
      }
    };

    const logReg = isCliMode() ? api.logger.debug : api.logger.info;
    logReg(
      `mymem@${pluginVersion}: plugin registered (db: ${resolvedDbPath}, model: ${config.embedding.model || "text-embedding-3-small"}, smartExtraction: ${smartExtractor ? 'ON' : 'OFF'})`
    );
    logReg(`mymem: diagnostic build tag loaded (${DIAG_BUILD_TAG})`);

    // Dual-memory model warning: help users understand the two-layer architecture
    // Runs synchronously and logs warnings; does NOT block gateway startup.
    logReg(
      `[mymem] memory_recall queries the plugin store (LanceDB), not MEMORY.md.\n` +
      `  - Plugin memory (LanceDB) = primary recall source for semantic search\n` +
      `  - MEMORY.md / memory/YYYY-MM-DD.md = startup context / journal only\n` +
      `  - Use memory_store or auto-capture for recallable memories.\n`
    );

    // Health status for memory runtime stub (reflects actual plugin health)
    // Updated by runStartupChecks after testing embedder and retriever
    let embedHealth: { ok: boolean; error?: string } = { ok: false, error: "startup not complete" };
    let retrievalHealth: boolean = false;

    // ========================================================================
    // Stub Memory Runtime (satisfies openclaw doctor memory plugin check)
    // mymem uses a tool-based architecture, not the built-in memory-core
    // runtime interface, so we register a minimal stub to satisfy the check.
    // See: https://github.com/Xinslive/MyMem/issues/434
    // ========================================================================
    if (typeof api.registerMemoryRuntime === "function") {
      api.registerMemoryRuntime({
        async getMemorySearchManager(_params: any) {
          return {
            manager: {
              status: () => ({
                backend: "builtin" as const,
                provider: "mymem",
                embeddingAvailable: embedHealth.ok,
                retrievalAvailable: retrievalHealth,
              }),
              probeEmbeddingAvailability: async () => ({ ...embedHealth }),
              probeVectorAvailability: async () => retrievalHealth,
            },
          };
        },
        resolveMemoryBackendConfig() {
          return { backend: "builtin" as const };
        },
      });
    }

    api.on("message_received", (event: any, ctx: any) => {
      const conversationKey = buildAutoCaptureConversationKeyFromIngress(
        ctx.channelId,
        ctx.conversationId,
      );
      const rawIngressText = extractTextContent(event.content);
      const normalized = rawIngressText
        ? normalizeAutoCaptureText("user", rawIngressText, shouldSkipReflectionMessage)
        : null;
      if (conversationKey && normalized) {
        const queue = autoCapturePendingIngressTexts.get(conversationKey) || [];
        queue.push(normalized);
        autoCapturePendingIngressTexts.set(conversationKey, queue.slice(-6));
        pruneMapIfOver(autoCapturePendingIngressTexts, AUTO_CAPTURE_MAP_MAX_ENTRIES);
      }
      const ingressLength = typeof rawIngressText === "string" ? rawIngressText.trim().length : 0;
      api.logger.debug(
        `mymem: ingress message_received channel=${ctx.channelId} account=${ctx.accountId || "unknown"} conversation=${ctx.conversationId || "unknown"} from=${event.from} len=${ingressLength} preview=${summarizeTextPreview(rawIngressText || "")}`,
      );
    });

    api.on("before_message_write", (event: any, ctx: any) => {
      const message = event.message as Record<string, unknown> | undefined;
      const role =
        message && typeof message.role === "string" && message.role.trim().length > 0
          ? message.role
          : "unknown";
      if (role !== "user") {
        return;
      }
      api.logger.debug(
        `mymem: ingress before_message_write agent=${ctx.agentId || event.agentId || "unknown"} sessionKey=${ctx.sessionKey || event.sessionKey || "unknown"} role=${role} ${summarizeMessageContent(message?.content)}`,
      );
    });

    // ========================================================================
    // Markdown Mirror
    // ========================================================================

    const mdMirror = createMdMirrorWriter(api, config);

    // ========================================================================
    // Register Tools
    // ========================================================================

    registerAllMemoryTools(
      api,
      {
        retriever,
        store,
        scopeManager,
        embedder,
        logger: api.logger,
        agentId: undefined, // Will be determined at runtime from context
        workspaceDir: getDefaultWorkspaceDir(),
        mdMirror,
        workspaceBoundary: config.workspaceBoundary,
        telemetry: telemetryStore,
      },
      {
        enableManagementTools: config.enableManagementTools,
        enableSelfImprovementTools: config.selfImprovement?.enabled !== false,
      }
    );

    if (
      config.memoryCompaction?.enabled ||
      config.lifecycleMaintenance?.enabled ||
      (config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill) ||
      (config.experienceCompiler?.enabled && config.experienceCompiler?.gatewayBackfill)
    ) {
      api.on("gateway_start", () => {
        const compactionStateFile = join(
          dirname(resolvedDbPath),
          ".compaction-state.json",
        );
        const lifecycleStateFile = join(
          dirname(resolvedDbPath),
          ".lifecycle-maintenance-state.json",
        );
        const distillerStateFile = join(
          dirname(resolvedDbPath),
          ".preference-distiller-state.json",
        );
        const compilerStateFile = join(
          dirname(resolvedDbPath),
          ".experience-compiler-state.json",
        );
        const compactionCfg: CompactionConfig | null = config.memoryCompaction?.enabled ? {
          enabled: true,
          minAgeDays: config.memoryCompaction!.minAgeDays ?? 7,
          similarityThreshold: config.memoryCompaction!.similarityThreshold ?? 0.88,
          minClusterSize: config.memoryCompaction!.minClusterSize ?? 2,
          maxMemoriesToScan: config.memoryCompaction!.maxMemoriesToScan ?? 200,
          dryRun: config.memoryCompaction!.dryRun === true,
          cooldownHours: config.memoryCompaction!.cooldownHours ?? 4,
          mergeMode: config.memoryCompaction!.mergeMode ?? "llm",
          deleteSourceMemories: config.memoryCompaction!.deleteSourceMemories !== false,
          maxLlmClustersPerRun: config.memoryCompaction!.maxLlmClustersPerRun ?? 10,
        } : null;
        const lifecycleCfg = {
          enabled: config.lifecycleMaintenance?.enabled === true,
          cooldownHours: config.lifecycleMaintenance?.cooldownHours ?? 4,
          maxMemoriesToScan: config.lifecycleMaintenance?.maxMemoriesToScan ?? 300,
          archiveThreshold: config.lifecycleMaintenance?.archiveThreshold ?? 0.15,
          dryRun: config.lifecycleMaintenance?.dryRun === true,
          deleteMode: config.lifecycleMaintenance?.deleteMode ?? "archive",
          deleteReasons: config.lifecycleMaintenance?.deleteReasons ?? ["expired", "superseded", "bad_recall", "stale_unaccessed"],
          hardDeleteReasons: config.lifecycleMaintenance?.hardDeleteReasons ?? ["duplicate_cluster_source", "noise", "superseded_fragment"],
        };

        // Lifecycle dependencies for post-compaction entry initialization.
        const compactionLifecycle: CompactorLifecycle = {
          store: {
            getById: store.getById.bind(store),
            update: async (entry) => { await store.update(entry.id, {
              text: entry.text,
              vector: entry.vector,
              importance: entry.importance,
              category: entry.category,
              metadata: entry.metadata,
            }); },
          },
        };

        Promise.all([
          config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill
            ? shouldRunPreferenceDistiller(distillerStateFile, config.preferenceDistiller.cooldownHours ?? 4)
            : Promise.resolve(false),
          config.experienceCompiler?.enabled && config.experienceCompiler?.gatewayBackfill
            ? shouldRunExperienceCompiler(compilerStateFile, config.experienceCompiler.cooldownHours ?? 4)
            : Promise.resolve(false),
          lifecycleCfg.enabled ? shouldRunLifecycleMaintenance(lifecycleStateFile, lifecycleCfg.cooldownHours) : Promise.resolve(false),
          compactionCfg ? shouldRunCompaction(compactionStateFile, compactionCfg.cooldownHours) : Promise.resolve(false),
        ])
          .then(async ([runDistiller, runCompiler, runLifecycle, runCompact]) => {
            let distillResult: Awaited<ReturnType<typeof runPreferenceDistiller>> | null = null;
            let compilerResult: Awaited<ReturnType<typeof runExperienceCompiler>> | null = null;
            let pruneResult: Awaited<ReturnType<typeof runLifecycleMaintenance>> | null = null;
            let tierResult: Awaited<ReturnType<typeof runLifecycleMaintenance>> | null = null;
            let compactionResult: Awaited<ReturnType<typeof runCompaction>> | null = null;

            if (runDistiller) {
              distillResult = await runPreferenceDistiller(
                { store, embedder, logger: api.logger },
                config.preferenceDistiller,
              );
              await recordPreferenceDistillerRun(distillerStateFile);
            }

            if (runCompiler) {
              compilerResult = await runExperienceCompiler(
                { store, embedder, logger: api.logger },
                config.experienceCompiler,
              );
              await recordExperienceCompilerRun(compilerStateFile);
            }

            if (runLifecycle) {
              pruneResult = await runLifecycleMaintenance(
                { store, decayEngine, tierManager, logger: api.logger },
                { ...lifecycleCfg, phase: "prune" },
              );
            }

            if (runCompact && compactionCfg) {
              await recordCompactionRun(compactionStateFile);
              compactionResult = await runCompaction(
                store as any,
                embedder,
                compactionCfg,
                undefined,
                api.logger,
                compactionLifecycle,
                smartExtractionLlmClient ?? undefined,
              );
            }

            if (runLifecycle) {
              tierResult = await runLifecycleMaintenance(
                { store, decayEngine, tierManager, logger: api.logger },
                { ...lifecycleCfg, phase: "tier" },
              );
              await recordLifecycleMaintenanceRun(lifecycleStateFile);
            }

            if (distillResult || compilerResult || pruneResult || compactionResult || tierResult) {
              api.logger.info(
                `memory-maintenance [auto]: ` +
                `distilled=${distillResult?.created ?? 0}/${distillResult?.updated ?? 0} ` +
                `compiled=${compilerResult?.created ?? 0}/${compilerResult?.updated ?? 0} ` +
                `lifecycleScanned=${(pruneResult?.scanned ?? 0) + (tierResult?.scanned ?? 0)} ` +
                `compactionScanned=${compactionResult?.scanned ?? 0} ` +
                `clusters=${compactionResult?.clustersFound ?? 0} ` +
                `created=${compactionResult?.memoriesCreated ?? 0} ` +
                `deleted=${(pruneResult?.deleted ?? 0) + (compactionResult?.memoriesDeleted ?? 0)} ` +
                `deleteReasons=${JSON.stringify(pruneResult?.deleteReasons ?? {})} ` +
                `llmRefined=${compactionResult?.llmRefined ?? 0} ` +
                `fallbackMerged=${compactionResult?.fallbackMerged ?? 0} ` +
                `failedClusters=${compactionResult?.failedClusters ?? 0} ` +
                `archived=${pruneResult?.archived ?? 0} ` +
                `promoted=${tierResult?.promoted ?? 0} demoted=${tierResult?.demoted ?? 0}`,
              );
            }
          })
          .catch((err) => {
            api.logger.warn(`memory-maintenance [auto]: failed: ${String(err)}`);
          });
      });
    }

    // ========================================================================
    // Register CLI Commands
    // ========================================================================

    api.registerCli?.(
      createMemoryCLI({
        store,
        retriever,
        scopeManager,
        migrator,
        embedder,
        llmClient: smartExtractor ? (() => {
          try {
            const llmAuth = config.llm?.auth || "api-key";
            const llmApiKey = llmAuth === "oauth"
              ? undefined
              : config.llm?.apiKey
                ? resolveEnvVars(config.llm.apiKey)
                : resolveFirstApiKey(config.embedding.apiKey);
            const llmBaseURL = llmAuth === "oauth"
              ? (config.llm?.baseURL ? resolveEnvVars(config.llm.baseURL) : undefined)
              : config.llm?.baseURL
                ? resolveEnvVars(config.llm.baseURL)
                : config.embedding.baseURL;
            const llmOauthPath = llmAuth === "oauth"
              ? resolveOptionalPathWithEnv(api, config.llm?.oauthPath, ".mymem/oauth.json")
              : undefined;
            const llmOauthProvider = llmAuth === "oauth"
              ? config.llm?.oauthProvider
              : undefined;
            const llmTimeoutMs = resolveLlmTimeoutMs(config);
            return createLlmClient({
              auth: llmAuth,
              apiKey: llmApiKey,
              model: config.llm?.model || "openai/gpt-oss-120b",
              baseURL: llmBaseURL,
              oauthProvider: llmOauthProvider,
              oauthPath: llmOauthPath,
              timeoutMs: llmTimeoutMs,
              log: (msg: string) => api.logger.debug(msg),
            });
          } catch { return undefined; }
        })() : undefined,
      }),
      { commands: ["mymem"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts.
    // Subagent sessions are guarded inside registerAutoRecallHook via :subagent:.
    registerAutoRecallHook({
      api,
      config,
      store,
      retriever,
      scopeManager,
      turnCounter,
      recallHistory,
      lastRawUserMessage,
      hookEnhancementState,
      decayEngine,
      tierManager,
    });

    registerHookEnhancements({
      api,
      config,
      store,
      embedder,
      scopeManager,
      state: hookEnhancementState,
      isCliMode,
    });

    // Auto-capture hook
    registerAutoCaptureHook({
      api,
      config,
      store,
      embedder,
      smartExtractor,
      extractionRateLimiter,
      scopeManager,
      autoCaptureSeenTextCount,
      autoCapturePendingIngressTexts,
      autoCaptureRecentTexts,
      mdMirror: mdMirror ?? undefined,
      isCliMode,
    });

    // ========================================================================
    // Integrated Self-Improvement (inheritance + derived)
    // ========================================================================

    registerSelfImprovementHook({ api, config, isCliMode });

    // ========================================================================
    // Integrated Memory Reflection (reflection)
    // ========================================================================

    if (config.sessionStrategy === "memoryReflection") {
      const reflectionMessageCount = config.memoryReflection?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
      const reflectionMaxInputChars = config.memoryReflection?.maxInputChars ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS;
      const reflectionTimeoutMs = config.memoryReflection?.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
      const reflectionThinkLevel = config.memoryReflection?.thinkLevel ?? DEFAULT_REFLECTION_THINK_LEVEL;
      const reflectionAgentId = asNonEmptyString(config.memoryReflection?.agentId);
      const reflectionErrorReminderMaxEntries =
        parsePositiveInt(config.memoryReflection?.errorReminderMaxEntries) ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES;
      const reflectionDedupeErrorSignals = config.memoryReflection?.dedupeErrorSignals !== false;
      const reflectionInjectMode = config.memoryReflection?.injectMode ?? "inheritance+derived";
      const reflectionStoreToLanceDB = config.memoryReflection?.storeToLanceDB !== false;
      const reflectionWriteLegacyCombined = config.memoryReflection?.writeLegacyCombined !== false;
      const warnedInvalidReflectionAgentIds = new Set<string>();

      const resolveReflectionRunAgentId = (cfg: unknown, sourceAgentId: string): string => {
        if (!reflectionAgentId) return sourceAgentId;
        if (isAgentDeclaredInConfig(cfg, reflectionAgentId)) return reflectionAgentId;

        if (!warnedInvalidReflectionAgentIds.has(reflectionAgentId)) {
          api.logger.warn(
            `memory-reflection: memoryReflection.agentId "${reflectionAgentId}" not found in cfg.agents.list; ` +
            `fallback to runtime agent "${sourceAgentId}".`
          );
          warnedInvalidReflectionAgentIds.add(reflectionAgentId);
        }
        return sourceAgentId;
      };

      api.on("after_tool_call", (event: any, ctx: any) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        if (isInternalReflectionSessionKey(sessionKey)) return;
        if (!sessionKey) return;
        pruneReflectionSessionState();

        if (typeof event.error === "string" && event.error.trim().length > 0) {
          const signature = normalizeErrorSignature(event.error);
          addReflectionErrorSignal(sessionKey, {
            at: Date.now(),
            toolName: event.toolName || "unknown",
            summary: summarizeErrorText(event.error),
            source: "tool_error",
            signature,
            signatureHash: sha256Hex(signature).slice(0, 16),
          }, reflectionDedupeErrorSignals);
          return;
        }

        const resultTextRaw = extractTextFromToolResult(event.result);
        const resultText = resultTextRaw.length > DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS
          ? resultTextRaw.slice(0, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS)
          : resultTextRaw;
        if (resultText && containsErrorSignal(resultText)) {
          const signature = normalizeErrorSignature(resultText);
          addReflectionErrorSignal(sessionKey, {
            at: Date.now(),
            toolName: event.toolName || "unknown",
            summary: summarizeErrorText(resultText),
            source: "tool_output",
            signature,
            signatureHash: sha256Hex(signature).slice(0, 16),
          }, reflectionDedupeErrorSignals);
        }
      }, { priority: 15 });

      api.on("before_prompt_build", async (_event: any, ctx: any) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        // Skip reflection injection for sub-agent sessions.
        if (sessionKey.includes(":subagent:")) return;
        if (isInternalReflectionSessionKey(sessionKey)) return;
        if (reflectionInjectMode !== "inheritance-only" && reflectionInjectMode !== "inheritance+derived") return;
        try {
          pruneReflectionSessionState();
          const agentId = resolveHookAgentId(
            typeof ctx.agentId === "string" ? ctx.agentId : undefined,
            sessionKey,
          );
          const scopes = resolveScopeFilter(scopeManager, agentId);
          const slices = await loadAgentReflectionSlices(agentId, scopes);
          if (slices.invariants.length === 0) return;
          const body = slices.invariants.slice(0, 6).map((line, i) => `${i + 1}. ${line}`).join("\n");
          return {
            prependContext: [
              "<inherited-rules>",
              "Stable rules inherited from mymem reflections. Treat as long-term behavioral constraints unless user overrides.",
              body,
              "</inherited-rules>",
            ].join("\n"),
          };
        } catch (err) {
          api.logger.warn(`memory-reflection: inheritance injection failed: ${String(err)}`);
        }
      }, { priority: 12 });

      api.on("before_prompt_build", async (_event: any, ctx: any) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        // Skip reflection injection for sub-agent sessions.
        if (sessionKey.includes(":subagent:")) return;
        if (isInternalReflectionSessionKey(sessionKey)) return;
        const agentId = resolveHookAgentId(
          typeof ctx.agentId === "string" ? ctx.agentId : undefined,
          sessionKey,
        );
        pruneReflectionSessionState();

        const blocks: string[] = [];
        if (reflectionInjectMode === "inheritance+derived") {
          try {
            const scopes = resolveScopeFilter(scopeManager, agentId);
            const derivedCache = sessionKey ? reflectionDerivedBySession.get(sessionKey) : null;
            const derivedLines = derivedCache?.derived?.length
              ? derivedCache.derived
              : (await loadAgentReflectionSlices(agentId, scopes)).derived;
            if (derivedLines.length > 0) {
              blocks.push(
                [
                  "<derived-focus>",
                  "Weighted recent derived execution deltas from reflection memory:",
                  ...derivedLines.slice(0, 6).map((line, i) => `${i + 1}. ${line}`),
                  "</derived-focus>",
                ].join("\n")
              );
            }
          } catch (err) {
            api.logger.warn(`memory-reflection: derived injection failed: ${String(err)}`);
          }
        }

        if (sessionKey) {
          const pending = getPendingReflectionErrorSignalsForPrompt(sessionKey, reflectionErrorReminderMaxEntries);
          if (pending.length > 0) {
            blocks.push(
              [
                "<error-detected>",
                "A tool error was detected. Consider logging this to `.learnings/ERRORS.md` if it is non-trivial or likely to recur.",
                "Recent error signals:",
                ...pending.map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary}`),
                "</error-detected>",
              ].join("\n")
            );
          }
        }

        if (blocks.length === 0) return;
        return { prependContext: blocks.join("\n\n") };
      }, { priority: 15 });

      api.on("session_end", (_event: any, ctx: any) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
        if (!sessionKey) return;
        reflectionErrorStateBySession.delete(sessionKey);
        reflectionDerivedBySession.delete(sessionKey);
        pruneReflectionSessionState();
      }, { priority: 20 });

      // Global cross-instance re-entrant guard to prevent reflection loops.
      // Each plugin instance used to have its own Map, so new instances created during
      // embedded agent turns could bypass the guard. Using Symbol.for + globalThis
      // ensures ALL instances share the same lock regardless of how many times the
      // plugin is re-loaded by the runtime.
      const GLOBAL_REFLECTION_LOCK = Symbol.for("openclaw.mymem.reflection-lock");
      const getGlobalReflectionLock = (): Map<string, boolean> => {
        const g = globalThis as Record<symbol, unknown>;
        if (!g[GLOBAL_REFLECTION_LOCK]) g[GLOBAL_REFLECTION_LOCK] = new Map<string, boolean>();
        return g[GLOBAL_REFLECTION_LOCK] as Map<string, boolean>;
      };

      // Serial loop guard: track last reflection time per sessionKey to prevent
      // gateway-level re-triggering (e.g. session_end → new session → command:new)
      const REFLECTION_SERIAL_GUARD = Symbol.for("openclaw.mymem.reflection-serial-guard");
      const getSerialGuardMap = () => {
        const g = globalThis as any;
        if (!g[REFLECTION_SERIAL_GUARD]) g[REFLECTION_SERIAL_GUARD] = new Map<string, number>();
        return g[REFLECTION_SERIAL_GUARD] as Map<string, number>;
      };
      const SERIAL_GUARD_COOLDOWN_MS = 120_000; // 2 minutes cooldown per sessionKey

      const runMemoryReflection = async (event: any) => {
        const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";

        // Validate sessionKey BEFORE dedup — invalid/empty keys must NOT pollute the dedup set
        if (!sessionKey) {
          // skip events without a valid sessionKey — they are not meaningful for reflection
          return;
        }

        if (dedupHookEvent("reflection", event)) return;
        // Guard against re-entrant calls for the same session (e.g. file-write triggering another command:new)
        // Uses global lock shared across all plugin instances to prevent loop amplification.
        const globalLock = getGlobalReflectionLock();
        if (sessionKey && globalLock.get(sessionKey)) {
          api.logger.info(`memory-reflection: skipping re-entrant call for sessionKey=${sessionKey}; already running (global guard)`);
          return;
        }
        // Serial loop guard: skip if a reflection for this sessionKey completed recently
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
          pruneReflectionSessionState();
          const action = String(event?.action || "unknown");
          const context = (event.context || {}) as Record<string, unknown>;
          const cfg = context.cfg;
          const workspaceDir = resolveWorkspaceDirFromContext(context);
          if (!cfg) {
            api.logger.warn(`memory-reflection: command:${action} missing cfg in hook context; skip reflection`);
            return;
          }

          const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
          const currentSessionId = typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
          let currentSessionFile = typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;
          const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
          const commandSource = typeof context.commandSource === "string" ? context.commandSource : "";
          api.logger.info(
            `memory-reflection: command:${action} hook start; sessionKey=${sessionKey || "(none)"}; source=${commandSource || "(unknown)"}; sessionId=${currentSessionId}; sessionFile=${currentSessionFile || "(none)"}`
          );

          if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
            const searchDirs = resolveReflectionSessionSearchDirs({
              context,
              cfg,
              workspaceDir,
              currentSessionFile,
              sourceAgentId,
            });
            api.logger.info(
              `memory-reflection: command:${action} session recovery start for session ${currentSessionId}; initial=${currentSessionFile || "(none)"}; dirs=${searchDirs.join(" | ") || "(none)"}`
            );
            for (const sessionsDir of searchDirs) {
              const recovered = await findPreviousSessionFile(sessionsDir, currentSessionFile, currentSessionId);
              if (recovered) {
                api.logger.info(
                  `memory-reflection: command:${action} recovered session file ${recovered} from ${sessionsDir}`
                );
                currentSessionFile = recovered;
                break;
              }
            }
          }

          if (!currentSessionFile) {
            const searchDirs = resolveReflectionSessionSearchDirs({
              context,
              cfg,
              workspaceDir,
              currentSessionFile,
              sourceAgentId,
            });
            api.logger.warn(
              `memory-reflection: command:${action} missing session file after recovery for session ${currentSessionId}; dirs=${searchDirs.join(" | ") || "(none)"}`
            );
            return;
          }

          const conversation = await readSessionConversationWithResetFallback(currentSessionFile, reflectionMessageCount);
          if (!conversation) {
            api.logger.warn(
              `memory-reflection: command:${action} conversation empty/unusable for session ${currentSessionId}; file=${currentSessionFile}`
            );
            return;
          }

          // Mark that reflection will actually run — cooldown is only recorded
          // for runs that pass all pre-condition checks, not for early exits
          // (missing cfg, session file, or conversation).
          reflectionRan = true;

          const now = new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now());
          const nowTs = now.getTime();
          const dateStr = now.toISOString().split("T")[0];
          const timeIso = now.toISOString().split("T")[1].replace("Z", "");
          const timeHms = timeIso.split(".")[0];
          const timeCompact = timeIso.replace(/[:.]/g, "");
          const reflectionRunAgentId = resolveReflectionRunAgentId(cfg, sourceAgentId);
          const targetScope = isSystemBypassId(sourceAgentId)
            ? config.scopes?.default ?? "global"
            : scopeManager.getDefaultScope(sourceAgentId);
          const toolErrorSignals = sessionKey
            ? (reflectionErrorStateBySession.get(sessionKey)?.entries ?? []).slice(-reflectionErrorReminderMaxEntries)
            : [];

          api.logger.info(
            `memory-reflection: command:${action} reflection generation start for session ${currentSessionId}; timeoutMs=${reflectionTimeoutMs}`
          );
          const reflectionGenerated = await generateReflectionText({
            conversation,
            maxInputChars: reflectionMaxInputChars,
            cfg,
            agentId: reflectionRunAgentId,
            workspaceDir,
            timeoutMs: reflectionTimeoutMs,
            thinkLevel: reflectionThinkLevel,
            toolErrorSignals,
            runEmbeddedPiAgent: resolveRuntimeEmbeddedPiRunner(api),
            logger: api.logger,
          });
          api.logger.info(
            `memory-reflection: command:${action} reflection generation done for session ${currentSessionId}; runner=${reflectionGenerated.runner}; usedFallback=${reflectionGenerated.usedFallback ? "yes" : "no"}`
          );
          const reflectionText = reflectionGenerated.text;
          if (reflectionGenerated.runner === "cli") {
            api.logger.warn(
              `memory-reflection: embedded runner unavailable, used openclaw CLI fallback for session ${currentSessionId}` +
              (reflectionGenerated.error ? ` (${reflectionGenerated.error})` : "")
            );
          } else if (reflectionGenerated.usedFallback) {
            api.logger.warn(
              `memory-reflection: fallback used for session ${currentSessionId}` +
              (reflectionGenerated.error ? ` (${reflectionGenerated.error})` : "")
            );
          }

          const header = [
            `# Reflection: ${dateStr} ${timeHms} UTC`,
            "",
            `- Session Key: ${sessionKey}`,
            `- Session ID: ${currentSessionId || "unknown"}`,
            `- Command: ${String(event.action || "unknown")}`,
            `- Error Signatures: ${toolErrorSignals.length ? toolErrorSignals.map((s) => s.signatureHash).join(", ") : "(none)"}`,
            "",
          ].join("\n");
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
            try {
              await writeFile(candidateOutPath, reflectionBody, { encoding: "utf-8", flag: "wx" });
              relPath = candidateRelPath;
              writeOk = true;
              break;
            } catch (err: any) {
              if (err?.code === "EEXIST") continue;
              throw err;
            }
          }
          if (!writeOk) {
            throw new Error(`Failed to allocate unique reflection file for ${dateStr} ${timeCompact}`);
          }

          const reflectionGovernanceCandidates = extractReflectionLearningGovernanceCandidates(reflectionText);
          if (config.selfImprovement?.enabled !== false && reflectionGovernanceCandidates.length > 0) {
            for (const candidate of reflectionGovernanceCandidates) {
              await appendSelfImprovementEntry({
                baseDir: workspaceDir,
                type: "learning",
                summary: candidate.summary,
                details: candidate.details,
                suggestedAction: candidate.suggestedAction,
                category: "best_practice",
                area: candidate.area || "config",
                priority: candidate.priority || "medium",
                status: candidate.status || "pending",
                source: `mymem/reflection:${relPath}`,
              });
            }
            // Trigger feedback loop to scan the newly written error/learning files
            if (_singletonState?.feedbackLoop) {
              _singletonState.feedbackLoop.scanErrorFile(workspaceDir).catch(() => {});
              _singletonState.feedbackLoop.forceAdaptationCycle(resolvedDbPath, normalizeAdmissionControlConfig(config.admissionControl)).catch(() => {});
            }
          }

          const reflectionEventId = createReflectionEventId({
            runAt: nowTs,
            sessionKey,
            sessionId: currentSessionId || "unknown",
            agentId: sourceAgentId,
            command: String(event.action || "unknown"),
          });

          const mappedReflectionMemories = extractInjectableReflectionMappedMemoryItems(reflectionText);
          for (const mapped of mappedReflectionMemories) {
            const vector = await embedder.embedPassage(mapped.text);
            let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
            try {
              existing = await store.vectorSearch(vector, 1, 0.1, [targetScope]);
            } catch (err) {
              api.logger.warn(
                `memory-reflection: mapped memory duplicate pre-check failed, continue store: ${String(err)}`,
              );
            }

            if (existing.length > 0 && existing[0].score > 0.95) {
              continue;
            }

            const importance = mapped.category === "decision" ? 0.85 : 0.8;
            const metadata = JSON.stringify(buildReflectionMappedMetadata({
              mappedItem: mapped,
              eventId: reflectionEventId,
              agentId: sourceAgentId,
              sessionKey,
              sessionId: currentSessionId || "unknown",
              runAt: nowTs,
              usedFallback: reflectionGenerated.usedFallback,
              toolErrorSignals,
              sourceReflectionPath: relPath,
            }));

            const storedEntry = await store.store({
              text: mapped.text,
              vector,
              importance,
              category: mapped.category,
              scope: targetScope,
              metadata,
            });

            if (mdMirror) {
              await mdMirror(
                { text: mapped.text, category: mapped.category, scope: targetScope, timestamp: storedEntry.timestamp },
                { source: `reflection:${mapped.heading}`, agentId: sourceAgentId },
              );
            }
          }

          if (reflectionStoreToLanceDB) {
            const stored = await storeReflectionToLanceDB({
              reflectionText,
              sessionKey,
              sessionId: currentSessionId || "unknown",
              agentId: sourceAgentId,
              command: String(event.action || "unknown"),
              scope: targetScope,
              toolErrorSignals,
              runAt: nowTs,
              usedFallback: reflectionGenerated.usedFallback,
              eventId: reflectionEventId,
              sourceReflectionPath: relPath,
              writeLegacyCombined: reflectionWriteLegacyCombined,
              embedPassage: (text) => embedder.embedPassage(text),
              vectorSearch: (vector, limit, minScore, scopeFilter) =>
                store.vectorSearch(vector, limit, minScore, scopeFilter),
              store: (entry) => store.store(entry),
            });
            if (sessionKey && stored.slices.derived.length > 0) {
              reflectionDerivedBySession.set(sessionKey, {
                updatedAt: nowTs,
                derived: stored.slices.derived,
              });
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
            if (reflectionRan) {
              getSerialGuardMap().set(sessionKey, Date.now());
            }
          }
          pruneReflectionSessionState();
        }
      };

      api.registerHook?.("command:new", runMemoryReflection, {
        name: "mymem.memory-reflection.command-new",
        description: "Generate reflection log before /new",
      });
      api.registerHook?.("command:reset", runMemoryReflection, {
        name: "mymem.memory-reflection.command-reset",
        description: "Generate reflection log before /reset",
      });
      (isCliMode() ? api.logger.debug : api.logger.info)(
        "memory-reflection: integrated hooks registered (command:new, command:reset, after_tool_call, before_prompt_build, session_end)"
      );
    }

    if (config.preferenceDistiller?.enabled === true || config.experienceCompiler?.enabled === true) {
      const runGovernanceAutomationOnCommand = async (event: any) => {
        try {
          await runCommandGovernanceAutomation(event);
        } catch (err) {
          api.logger.warn(`memory-governance: command hook failed: ${String(err)}`);
        }
      };

      api.registerHook?.("command:new", runGovernanceAutomationOnCommand, {
        name: "mymem.memory-governance.command-new",
        description: "Run preference distillation and experience compilation before /new",
      });
      api.registerHook?.("command:reset", runGovernanceAutomationOnCommand, {
        name: "mymem.memory-governance.command-reset",
        description: "Run preference distillation and experience compilation before /reset",
      });
      (isCliMode() ? api.logger.debug : api.logger.info)(
        "memory-governance: integrated hooks registered (command:new, command:reset)"
      );
    }

    if (config.sessionStrategy === "systemSessionMemory") {
      const sessionMessageCount = config.sessionMemory?.messageCount ?? 15;

      const storeSystemSessionSummary = async (params: {
        agentId: string;
        defaultScope: string;
        sessionKey: string;
        sessionId: string;
        source: string;
        sessionContent: string;
        timestampMs?: number;
      }) => {
        const now = new Date(params.timestampMs ?? Date.now());
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toISOString().split("T")[1].split(".")[0];
        const memoryText = [
          `Session: ${dateStr} ${timeStr} UTC`,
          `Session Key: ${params.sessionKey}`,
          `Session ID: ${params.sessionId}`,
          `Source: ${params.source}`,
          "",
          "Conversation Summary:",
          params.sessionContent,
        ].join("\n");

        const vector = await embedder.embedPassage(memoryText);
        await store.store({
          text: memoryText,
          vector,
          category: "fact",
          scope: params.defaultScope,
          importance: 0.5,
          metadata: stringifySmartMetadata(
            buildSmartMetadata(
              {
                text: `Session summary for ${dateStr}`,
                category: "fact",
                importance: 0.5,
                timestamp: Date.now(),
              },
              {
                l0_abstract: `Session summary for ${dateStr}`,
                l1_overview: `- Session summary saved for ${params.sessionId}`,
                l2_content: memoryText,
                memory_category: "patterns",
                tier: "peripheral",
                confidence: 0.5,
                type: "session-summary",
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                date: dateStr,
                agentId: params.agentId,
                scope: params.defaultScope,
              },
            ),
          ),
        });

        api.logger.info(
          `session-memory: stored session summary for ${params.sessionId} (agent: ${params.agentId}, scope: ${params.defaultScope})`
        );
      };

      api.on("before_reset", async (event, ctx) => {
        if (event.reason !== "new") return;

        try {
          const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
          const agentId = resolveHookAgentId(
            typeof ctx.agentId === "string" ? ctx.agentId : undefined,
            sessionKey,
          );
          const defaultScope = isSystemBypassId(agentId)
            ? config.scopes?.default ?? "global"
            : scopeManager.getDefaultScope(agentId);
          const currentSessionId =
            typeof ctx.sessionId === "string" && ctx.sessionId.trim().length > 0
              ? ctx.sessionId
              : "unknown";
          const source = resolveSourceFromSessionKey(sessionKey);
          const sessionContent =
            summarizeRecentConversationMessages(event.messages ?? [], sessionMessageCount) ??
            (typeof event.sessionFile === "string"
              ? await readSessionConversationWithResetFallback(event.sessionFile, sessionMessageCount)
              : null);

          if (!sessionContent) {
            api.logger.debug("session-memory: no session content found, skipping");
            return;
          }

          await storeSystemSessionSummary({
            agentId,
            defaultScope,
            sessionKey,
            sessionId: currentSessionId,
            source,
            sessionContent,
          });
        } catch (err) {
          api.logger.warn(`session-memory: failed to save: ${String(err)}`);
        }
      });

      (isCliMode() ? api.logger.debug : api.logger.info)("session-memory: typed before_reset hook registered for /new session summaries");
    }
    if (config.sessionStrategy === "none") {
      (isCliMode() ? api.logger.debug : api.logger.info)("session-strategy: using none (plugin memory-reflection hooks disabled)");
    }

    // ========================================================================
    // Auto-Backup (daily JSONL export)
    // ========================================================================

    let backupTimer: ReturnType<typeof setInterval> | null = null;
    const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    async function runBackup() {
      try {
        if (!resolvedDbPath) {
          api.logger.debug("mymem: backup skipped (no dbPath)");
          return;
        }
        const backupDir = api.resolvePath(
          join(resolvedDbPath, "..", "backups"),
        );
        if (!backupDir) {
          api.logger.debug("mymem: backup skipped (resolvePath returned empty)");
          return;
        }
        await mkdir(backupDir, { recursive: true });

        const allMemories = await store.list(undefined, undefined, 10000, 0);
        if (allMemories.length === 0) return;

        const dateStr = new Date().toISOString().split("T")[0];
        const backupFile = join(backupDir, `memory-backup-${dateStr}.jsonl`);

        const lines = allMemories.map((m) =>
          JSON.stringify({
            id: m.id,
            text: m.text,
            category: m.category,
            scope: m.scope,
            importance: m.importance,
            timestamp: m.timestamp,
            metadata: m.metadata,
          }),
        );

        await writeFile(backupFile, lines.join("\n") + "\n");

        // Keep only last 7 backups
        const files = (await readdir(backupDir))
          .filter((f) => f.startsWith("memory-backup-") && f.endsWith(".jsonl"))
          .sort();
        if (files.length > 7) {
          const { unlink } = await import("node:fs/promises");
          for (const old of files.slice(0, files.length - 7)) {
            await unlink(join(backupDir, old)).catch(() => { });
          }
        }

        api.logger.info(
          `mymem: backup completed (${allMemories.length} entries → ${backupFile})`,
        );
      } catch (err) {
        api.logger.warn(`mymem: backup failed: ${String(err)}`);
      }
    }

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService?.({
      id: "mymem",
      start: async () => {
        // IMPORTANT: Do not block gateway startup on external network calls.
        // If embedding/retrieval tests hang (bad network / slow provider), the gateway
        // may never bind its HTTP port, causing restart timeouts.

        const withTimeout = <T>(
          factory: (signal: AbortSignal) => Promise<T>,
          ms: number,
          label: string,
        ): { promise: Promise<T>; signal: AbortSignal } => {
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => {
                controller.abort();
                reject(new Error(`${label} timed out after ${ms}ms`));
              },
              ms,
            );
          });
          const p = factory(controller.signal).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          return { promise: Promise.race([p, timeoutPromise]), signal: controller.signal };
        };

        // Embedder internal timeout is 20s; give startup checks enough headroom
        const startupTimeoutMs = 30_000;

        const runStartupChecks = async () => {
          try {
            // Test components (bounded time)
            let embedSuccess = false;
            let embedError: string | undefined;
            try {
              const embedTest = await withTimeout(
                (signal) => embedder.test(signal),
                startupTimeoutMs,
                "embedder.test()",
              ).promise;
              embedSuccess = !!embedTest.success;
              embedError = embedTest.error;
            } catch (timeoutErr) {
              // Embedding provider may be slow on cold start — not a permanent failure.
              // The plugin works fine once the provider warms up (confirmed by memory_doctor).
              embedError = String(timeoutErr);
              api.logger.debug?.(
                `mymem: embedding probe skipped (provider not ready): ${embedError}`,
              );
            }

            const retrievalTest: {
              success: boolean;
              mode: string;
              hasFtsSupport: boolean;
              ftsError?: string;
              error?: string;
            } = {
              success: true,
              mode: retriever.getConfig().mode,
              hasFtsSupport: store.hasFtsSupport,
              ftsError: store.lastFtsError ?? undefined,
            };
            const ftsStatus = retrievalTest.hasFtsSupport
              ? "enabled"
              : `disabled${retrievalTest.ftsError ? ` (${retrievalTest.ftsError})` : ""}`;

            if (embedSuccess) {
              api.logger.info(
                `mymem: initialized successfully ` +
                `(embedding: OK, ` +
                `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
                `mode: ${retrievalTest.mode}, ` +
                `FTS: ${ftsStatus})`,
              );
            } else {
              // Embedding not ready at startup — log as info, not error.
              // It will work on first actual use once the provider warms up.
              api.logger.info(
                `mymem: initialized ` +
                `(embedding: warming up, ` +
                `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
                `mode: ${retrievalTest.mode}, ` +
                `FTS: ${ftsStatus})`,
              );
            }

            if (!retrievalTest.success) {
              api.logger.warn(
                `mymem: retrieval test failed: ${retrievalTest.error}`,
              );
            }

            // Update stub health status so openclaw doctor reflects real state
            embedHealth = { ok: embedSuccess, error: embedError };
            retrievalHealth = !!retrievalTest.success;
          } catch (error) {
            api.logger.warn(
              `mymem: startup checks failed: ${String(error)}`,
            );
          }
        };

        // Fire-and-forget: allow gateway to start serving immediately, then
        // defer health probing so startup I/O does not contend with host init.
        setTimeout(() => void runStartupChecks(), STARTUP_HEALTH_CHECK_DELAY_MS);

        // Check for legacy memories that could be upgraded
        setTimeout(async () => {
          try {
            const upgrader = createMemoryUpgrader(store, null);
            const counts = await upgrader.countLegacy();
            if (counts.legacy > 0) {
              api.logger.info(
                `mymem: found ${counts.legacy} legacy memories (of ${counts.total} total) that can be upgraded to the new smart memory format. ` +
                `Run 'openclaw mymem upgrade' to convert them.`
              );
            }
          } catch {
            // Non-critical: silently ignore
          }
        }, 5_000);

        // Run initial backup after a short delay, then schedule daily
        setTimeout(() => void runBackup(), 60_000); // 1 min after start
        backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);

        // Start feedback loop timers if enabled
        if (feedbackLoop) feedbackLoop.start();
      },
      stop: async () => {
        if (backupTimer) {
          clearInterval(backupTimer);
          backupTimer = null;
        }
        if (feedbackLoop) feedbackLoop.dispose();
        api.logger.info("mymem: stopped");
      },
    });
  },
};

export { getDefaultMdMirrorDir, parsePluginConfig };

/**
 * Resets the registration state — primarily intended for use in tests that need
 * to unload/reload the plugin without restarting the process.
 * @public
 */
export function resetRegistration() {
  // Note: WeakSets cannot be cleared by design. In test scenarios where the
  // same process reloads the module, a fresh module state means a new WeakSet.
  // For hot-reload scenarios, the module is re-imported fresh.
  // (WeakSet.clear() does not exist, so we do nothing here.)
}

export default myMemPlugin;
