/**
 * Plugin Singleton State — heavy resource initialization (runs once per process).
 *
 * Extracted from index.ts to reduce file size and improve separation of concerns.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ReflectionErrorState } from "./plugin-types.js";
import { DIAG_BUILD_TAG } from "./plugin-constants.js";
import { resolveEnvVars, resolveFirstApiKey, resolveOptionalPathWithEnv, resolveLlmTimeoutMs, pruneMapIfOver } from "./config-utils.js";
import { getDefaultDbPath, getDefaultWorkspaceDir } from "./path-utils.js";
import { parsePluginConfig } from "./plugin-config-parser.js";
import { getPluginVersion } from "./version-utils.js";

// Core components
import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { RetrievalStatsCollector } from "./retrieval-stats.js";
import { createScopeManager } from "./scopes.js";
import { createMigrator } from "./migrate.js";
import { parseClawteamScopes, applyClawteamScopes } from "./clawteam-scope.js";
import { SmartExtractor, createExtractionRateLimiter } from "./smart-extractor.js";
import { NoisePrototypeBank } from "./noise-prototypes.js";
import { HybridNoiseDetector } from "./noise-detector.js";
import { createLlmClient } from "./llm-client.js";
import type { LlmClient } from "./llm-client.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
import { RecencyEngine, DEFAULT_RECENCY_CONFIG } from "./recency-engine.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "./tier-manager.js";
import { TelemetryStore, resolveTelemetryDir } from "./telemetry.js";
import {
  normalizeAdmissionControlConfig,
  type AdmissionRejectionAuditEntry,
} from "./admission-control.js";
import {
  FeedbackLoop,
  normalizeFeedbackLoopConfig,
} from "./feedback-loop.js";
import {
  createAdmissionRejectionAuditWriter,
} from "./workspace-utils.js";
import { createHookEnhancementState } from "./hook-enhancements.js";

const pluginVersion = getPluginVersion();
const isCliMode = () => process.env.OPENCLAW_CLI === "1";

// ── Singleton State Interface ──────────────────────────────────────────

export interface PluginSingletonState {
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

// ── Singleton Lifecycle ────────────────────────────────────────────────

let _singletonState: PluginSingletonState | null = null;

export function getSingletonState(): PluginSingletonState | null {
  return _singletonState;
}

export function setSingletonState(state: PluginSingletonState | null): void {
  _singletonState = state;
}

/** Test-only: reset singleton state so each test gets a fresh init. */
export function __resetSingletonForTesting__(): void {
  _singletonState = null;
}

// ── Initialization ─────────────────────────────────────────────────────

export function initPluginState(api: OpenClawPluginApi): PluginSingletonState {
  const config = parsePluginConfig(api.pluginConfig);
  const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());
  const telemetryStore = new TelemetryStore(
    config.telemetry ?? { persist: true, maxRecords: 1000, sampleRate: 1 },
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
    provider: config.embedding.provider,
    apiVersion: config.embedding.apiVersion,
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
  const sharedNoiseBank = new NoisePrototypeBank((msg: string) => api.logger.debug(msg));
  sharedNoiseBank.init(embedder).catch((err) =>
    api.logger.debug(`mymem: noise bank init: ${String(err)}`),
  );
  const hybridNoiseDetector = new HybridNoiseDetector(embedder, sharedNoiseBank, {
    learnFromRegex: true,
    debugLog: (msg: string) => api.logger.debug(msg),
  });
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

      const admissionRejectionAuditWriter = createAdmissionRejectionAuditWriter(config, resolvedDbPath, api);

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
        onAdmissionAdmitted: (category: string) => {
          _singletonState?.feedbackLoop?.onAdmissionAdmitted(category);
        },
        onExtractionComplete: telemetryStore.enabled
          ? ({ sessionKey, scope, stats }) => telemetryStore.recordExtraction(sessionKey, scope, stats)
          : undefined,
        log: (msg: string) => api.logger.info(msg),
        debugLog: (msg: string) => api.logger.debug(msg),
        noiseBank: sharedNoiseBank,
      });

      (isCliMode() ? api.logger.debug : api.logger.info)(
        "mymem: smart extraction enabled (LLM model: "
        + llmModel
        + ", timeoutMs: "
        + llmTimeoutMs
        + ", noise bank: ON)",
      );

      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          noiseBank: sharedNoiseBank,
          embedder,
          admissionController: smartExtractor ? smartExtractor.getAdmissionController() : null,
          store,
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
      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          noiseBank: sharedNoiseBank,
          embedder,
          admissionController: null,
          store,
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
    feedbackLoop = new FeedbackLoop({
      noiseBank: sharedNoiseBank,
      embedder,
      admissionController: null,
      store,
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

  // Periodically prune unbounded session-keyed Maps to prevent memory leaks
  const SESSION_MAP_MAX = 500;
  const sessionMapsToPrune: Map<unknown, unknown>[] = [
    reflectionErrorStateBySession,
    reflectionDerivedBySession,
    reflectionByAgentCache,
    recallHistory,
    turnCounter,
    lastRawUserMessage,
    autoCaptureSeenTextCount,
    autoCapturePendingIngressTexts,
    autoCaptureRecentTexts,
  ];
  const _pruneInterval = setInterval(() => {
    for (const map of sessionMapsToPrune) pruneMapIfOver(map, SESSION_MAP_MAX);
  }, 5 * 60_000); // every 5 minutes
  if (typeof _pruneInterval === "object" && "unref" in _pruneInterval) _pruneInterval.unref();

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
