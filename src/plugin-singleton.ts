/**
 * Plugin Singleton State — heavy resource initialization (runs once per process).
 *
 * Extracted from index.ts to reduce file size and improve separation of concerns.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ReflectionErrorState } from "./plugin-types.js";
import { DIAG_BUILD_TAG } from "./plugin-constants.js";
import { resolveEnvVars, resolveFirstApiKey, resolveOptionalPathWithEnv, resolveLlmTimeoutMs, pruneMapIfOver } from "./config-utils.js";
import { getDefaultDbPath } from "./path-utils.js";
import { dirname, join } from "node:path";
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
import type { AutoRecallMetadataAccumulator } from "./auto-recall-metadata-accumulator.js";

const pluginVersion = getPluginVersion();
const isCliMode = () => process.env.OPENCLAW_CLI === "1";

// ── Singleton State Interface ──────────────────────────────────────────

export interface PluginSingletonState {
  config: ReturnType<typeof parsePluginConfig>;
  resolvedDbPath: string;
  store: MemoryStore;
  reflectionStore: MemoryStore;
  resolvedReflectionDbPath: string;
  embedder: ReturnType<typeof createEmbedder>;
  decayEngine: ReturnType<typeof createDecayEngine>;
  recencyEngine: RecencyEngine;
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
  sessionPruneInterval: ReturnType<typeof setInterval> | null;
  autoRecallMetadataAccumulators: Set<AutoRecallMetadataAccumulator>;
  autoRecallBackgroundTasks: Set<Promise<void>>;
  autoCaptureBackgroundTasks: Set<Promise<void>>;
  hookEnhancementBackgroundTasks: Set<Promise<void>>;
  reflectionBackgroundTasks: Set<Promise<void>>;
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

export function createPluginStateForTest(
  api: OpenClawPluginApi,
  overrides: Partial<PluginSingletonState> = {},
): PluginSingletonState {
  const config = parsePluginConfig(api.pluginConfig);
  const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());
  const noop = () => {};
  const emptyStats = async () => ({
    totalCount: 0,
    scopeCounts: {},
    categoryCounts: {},
    memoryCategoryCounts: {},
    recentActivity: { last24h: 0, last7d: 0, last30d: 0 },
    tierDistribution: {},
    healthSignals: { badRecall: 0, suppressed: 0, lowConfidence: 0 },
  });
  const storeStub = {
    hasFtsSupport: true,
    lastFtsError: null,
    stats: emptyStats,
    list: async () => [],
    getById: async () => null,
    update: async () => null,
    store: async (entry: any) => ({ id: "test-memory", timestamp: Date.now(), ...entry }),
    bm25Search: async () => [],
    vectorSearch: async () => [],
  } as unknown as MemoryStore;
  const embedderStub = {
    test: async () => ({ success: true }),
    embedQuery: async () => [],
    embedPassage: async () => [],
  } as unknown as ReturnType<typeof createEmbedder>;
  const retrieverStub = {
    getConfig: () => ({ ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval }),
    retrieve: async () => [],
    setStatsCollector: noop,
    getLastDiagnostics: () => null,
  } as unknown as ReturnType<typeof createRetriever>;
  const scopeManagerStub = createScopeManager(config.scopes);
  const telemetryStoreStub = {
    enabled: false,
    recordRetrieval: noop,
    recordExtraction: noop,
    flush: async () => undefined,
    getPersistentSummary: async () => ({ retrieval: null, extraction: null }),
  } as unknown as TelemetryStore;
  const base: PluginSingletonState = {
    config,
    resolvedDbPath,
    store: storeStub,
    reflectionStore: storeStub,
    resolvedReflectionDbPath: api.resolvePath(
      config.memoryReflection?.dbPath || join(dirname(resolvedDbPath), "mymem-reflection"),
    ),
    embedder: embedderStub,
    decayEngine: createDecayEngine({ ...DEFAULT_DECAY_CONFIG, ...(config.decay || {}) }),
    recencyEngine: new RecencyEngine({
      ...DEFAULT_RECENCY_CONFIG,
      ...(config.retrieval?.timeDecayHalfLifeDays
        ? { halfLifeDays: config.retrieval.timeDecayHalfLifeDays }
        : {}),
    }),
    tierManager: createTierManager({ ...DEFAULT_TIER_CONFIG, ...(config.tier || {}) }),
    retriever: retrieverStub,
    scopeManager: scopeManagerStub,
    migrator: createMigrator(storeStub),
    smartExtractor: null,
    smartExtractionLlmClient: null,
    extractionRateLimiter: createExtractionRateLimiter({ maxExtractionsPerHour: 0 }),
    feedbackLoop: null,
    telemetryStore: telemetryStoreStub,
    reflectionErrorStateBySession: new Map(),
    reflectionDerivedBySession: new Map(),
    reflectionByAgentCache: new Map(),
    recallHistory: new Map(),
    turnCounter: new Map(),
    lastRawUserMessage: new Map(),
    hookEnhancementState: createHookEnhancementState(),
    autoCaptureSeenTextCount: new Map(),
    autoCapturePendingIngressTexts: new Map(),
    autoCaptureRecentTexts: new Map(),
    sessionPruneInterval: null,
    autoRecallMetadataAccumulators: new Set(),
    autoRecallBackgroundTasks: new Set(),
    autoCaptureBackgroundTasks: new Set(),
    hookEnhancementBackgroundTasks: new Set(),
    reflectionBackgroundTasks: new Set(),
  };
  return { ...base, ...overrides };
}

// ── Initialization ─────────────────────────────────────────────────────

export function initPluginState(api: OpenClawPluginApi): PluginSingletonState {
  const config = parsePluginConfig(api.pluginConfig);
  const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());
  const resolvedReflectionDbPath = api.resolvePath(
    config.memoryReflection?.dbPath || join(dirname(resolvedDbPath), "mymem-reflection"),
  );
  const telemetryStore = new TelemetryStore(
    config.telemetry ?? { persist: true, maxRecords: 1000, sampleRate: 1 },
    api.resolvePath(resolveTelemetryDir(resolvedDbPath, config.telemetry?.dir)),
  );

  try {
    validateStoragePath(resolvedReflectionDbPath);
  } catch (err) {
    api.logger.warn(
      `mymem：反思记忆存储路径异常：${String(err)}\n` +
      `  反思写入可能失败，但主记忆写入不受影响。`,
    );
  }

  try {
    validateStoragePath(resolvedDbPath);
  } catch (err) {
    api.logger.warn(
      `mymem：存储路径异常：${String(err)}\n` +
      `  插件仍会尝试启动，但写入可能失败。`,
    );
  }

  const vectorDim = getVectorDimensions(
    config.embedding.model || "text-embedding-3-small",
    config.embedding.dimensions,
  );
  const store = new MemoryStore({ dbPath: resolvedDbPath, vectorDim });
  const reflectionStore = new MemoryStore({
    dbPath: resolvedReflectionDbPath,
    vectorDim,
    allowReflectionCategory: true,
  });
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
  const retriever = createRetriever(
    store,
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval, learningMemory: config.learningMemory },
    { decayEngine, recencyEngine, tierManager, logger: api.logger },
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
    api.logger.info(`mymem：CLAWTEAM_MEMORY_SCOPE 已添加作用域：${clawteamScopes.join(", ")}`);
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
        extractMinMessages: config.extractMinMessages ?? 8,
        extractMaxChars: config.extractMaxChars ?? 12000,
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
      });

      (isCliMode() ? api.logger.debug : api.logger.info)(
        "mymem：智能提取已启用（LLM模型："
        + llmModel
        + "，超时："
        + llmTimeoutMs
        + "ms）",
      );

      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          admissionController: smartExtractor ? smartExtractor.getAdmissionController() : null,
          store,
          llm: smartExtractionLlmClient,
          config: feedbackLoopConfig,
          debugLog: (msg: string) => api.logger.debug(msg),
          runtimeContext: {
            dbPath: resolvedDbPath,
            admissionConfig: feedbackLoopAdmissionConfig,
          },
        });
      }
    } catch (err) {
      api.logger.warn(`mymem：智能提取初始化失败，已回退到正则模式：${String(err)}`);
      if (feedbackLoopConfig.enabled) {
        feedbackLoop = new FeedbackLoop({
          admissionController: null,
          store,
          llm: smartExtractionLlmClient,
          config: feedbackLoopConfig,
          debugLog: (msg: string) => api.logger.debug(msg),
          runtimeContext: {
            dbPath: resolvedDbPath,
            admissionConfig: feedbackLoopAdmissionConfig,
          },
        });
      }
    }
  } else if (feedbackLoopConfig.enabled) {
    feedbackLoop = new FeedbackLoop({
      admissionController: null,
      store,
      llm: smartExtractionLlmClient,
      config: feedbackLoopConfig,
      debugLog: (msg: string) => api.logger.debug(msg),
      runtimeContext: {
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
  const autoRecallMetadataAccumulators = new Set<AutoRecallMetadataAccumulator>();
  const autoRecallBackgroundTasks = new Set<Promise<void>>();
  const autoCaptureBackgroundTasks = new Set<Promise<void>>();
  const hookEnhancementBackgroundTasks = new Set<Promise<void>>();
  const reflectionBackgroundTasks = new Set<Promise<void>>();

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
    `mymem@${pluginVersion}：插件已注册[单例初始化] `
    + `（数据库：${resolvedDbPath}，反思库：${resolvedReflectionDbPath}，模型：${config.embedding.model || "text-embedding-3-small"}）`,
  );
  logReg(`mymem：诊断构建标记已加载（${DIAG_BUILD_TAG}）`);

  return {
    config,
    resolvedDbPath,
    store,
    reflectionStore,
    resolvedReflectionDbPath,
    embedder,
    decayEngine,
    recencyEngine,
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
    sessionPruneInterval: _pruneInterval,
    autoRecallMetadataAccumulators,
    autoRecallBackgroundTasks,
    autoCaptureBackgroundTasks,
    hookEnhancementBackgroundTasks,
    reflectionBackgroundTasks,
  };
}
