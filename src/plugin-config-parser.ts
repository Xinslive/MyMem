/**
 * Plugin Configuration Parser
 *
 * Parses and normalizes plugin configuration from raw config objects.
 */

import { parsePositiveInt, resolveEnvVars } from "./config-utils.js";
import { clampInt } from "./utils.js";
import { asNonEmptyString } from "./cli-utils.js";
import { normalizeAdmissionControlConfig } from "./admission-control.js";
import { normalizeFeedbackLoopConfig } from "./feedback-loop.js";
import { createDefaultHookEnhancementsConfig } from "./hook-enhancements.js";
import { applyTuningPreset, resolveTuningPreset } from "./tuning-presets.js";
import { normalizeTelemetryConfig } from "./telemetry.js";
import type {
  PluginConfig,
  SessionStrategy,
  ReflectionInjectMode,
  SessionPrimerConfig,
  SelfCorrectionLoopConfig,
} from "./plugin-types.js";
import { DEFAULT_REFLECTION_MESSAGE_COUNT, DEFAULT_REFLECTION_MAX_INPUT_CHARS, DEFAULT_REFLECTION_TIMEOUT_MS, DEFAULT_REFLECTION_THINK_LEVEL, DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES, DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS } from "./plugin-constants.js";

/**
 * Parses and validates the plugin configuration.
 */
export function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mymem config required");
  }
  const rawCfg = value as Record<string, unknown>;
  const rawRetrieval =
    typeof rawCfg.retrieval === "object" && rawCfg.retrieval !== null
      ? (rawCfg.retrieval as Record<string, unknown>)
      : null;
  const tuningPreset = resolveTuningPreset(rawCfg.tuningPreset);
  const cfg = applyTuningPreset(rawCfg, tuningPreset);

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding) {
    throw new Error("embedding config is required");
  }

  // Accept single key (string) or array of keys for round-robin rotation
  let apiKey: string | string[];
  if (typeof embedding.apiKey === "string") {
    apiKey = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0) {
    // Validate every element is a non-empty string
    const invalid = embedding.apiKey.findIndex(
      (k: unknown) => typeof k !== "string" || (k as string).trim().length === 0,
    );
    if (invalid !== -1) {
      throw new Error(
        `embedding.apiKey[${invalid}] is invalid: expected non-empty string`,
      );
    }
    apiKey = embedding.apiKey as string[];
  } else if (embedding.apiKey !== undefined) {
    // apiKey is present but wrong type — throw, don't silently fall back
    throw new Error("embedding.apiKey must be a string or non-empty array of strings");
  } else {
    apiKey = process.env.OPENAI_API_KEY || "";
  }

  if (!apiKey || (Array.isArray(apiKey) && apiKey.length === 0)) {
    throw new Error("embedding.apiKey is required (set directly or via OPENAI_API_KEY env var)");
  }

  if (typeof embedding.baseURL !== "string" || embedding.baseURL.trim() === "") {
    throw new Error("embedding.baseURL is required");
  }

  if (typeof embedding.model !== "string" || embedding.model.trim() === "") {
    throw new Error("embedding.model is required");
  }

  const memoryReflectionRaw = typeof cfg.memoryReflection === "object" && cfg.memoryReflection !== null
    ? cfg.memoryReflection as Record<string, unknown>
    : null;
  const sessionMemoryRaw = typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
    ? cfg.sessionMemory as Record<string, unknown>
    : null;
  const workspaceBoundaryRaw = typeof cfg.workspaceBoundary === "object" && cfg.workspaceBoundary !== null
    ? cfg.workspaceBoundary as Record<string, unknown>
    : null;
  const userMdExclusiveRaw = typeof workspaceBoundaryRaw?.userMdExclusive === "object" && workspaceBoundaryRaw.userMdExclusive !== null
    ? workspaceBoundaryRaw.userMdExclusive as Record<string, unknown>
    : null;
  const sessionStrategyRaw = cfg.sessionStrategy;
  const legacySessionMemoryEnabled = typeof sessionMemoryRaw?.enabled === "boolean"
    ? sessionMemoryRaw.enabled
    : undefined;
  const sessionStrategy: SessionStrategy =
    sessionStrategyRaw === "systemSessionMemory" || sessionStrategyRaw === "memoryReflection" || sessionStrategyRaw === "none"
      ? sessionStrategyRaw
      : legacySessionMemoryEnabled === true
        ? "systemSessionMemory"
        : legacySessionMemoryEnabled === false
          ? "none"
          : "memoryReflection";
  const reflectionMessageCount = parsePositiveInt(memoryReflectionRaw?.messageCount ?? sessionMemoryRaw?.messageCount) ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
  const injectModeRaw = memoryReflectionRaw?.injectMode;
  const reflectionInjectMode: ReflectionInjectMode =
    injectModeRaw === "inheritance-only" || injectModeRaw === "inheritance+derived"
      ? injectModeRaw
      : "inheritance+derived";
  const reflectionStoreToLanceDB =
    sessionStrategy === "memoryReflection" &&
    (memoryReflectionRaw?.storeToLanceDB !== false);

  const hookEnhancementsRaw = typeof cfg.hookEnhancements === "object" && cfg.hookEnhancements !== null
    ? cfg.hookEnhancements as Record<string, unknown>
    : null;
  const defaultHookEnhancements = createDefaultHookEnhancementsConfig();

  const normalizeSessionPrimer = (raw: unknown): Required<SessionPrimerConfig> => {
    if (raw === false) {
      return {
        ...defaultHookEnhancements.sessionPrimer,
        enabled: false,
      };
    }
    if (raw === true || raw === undefined) {
      return { ...defaultHookEnhancements.sessionPrimer };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ...defaultHookEnhancements.sessionPrimer };
    }
    const objectRaw = raw as Record<string, unknown>;
    return {
      enabled: objectRaw.enabled !== false,
      preferDistilled: objectRaw.preferDistilled !== false,
      includeReflectionInvariants: objectRaw.includeReflectionInvariants !== false,
      maxItems: clampInt(parsePositiveInt(objectRaw.maxItems) ?? defaultHookEnhancements.sessionPrimer.maxItems, 1, 8),
      maxChars: clampInt(parsePositiveInt(objectRaw.maxChars) ?? defaultHookEnhancements.sessionPrimer.maxChars, 200, 2_000),
    };
  };

  const normalizeSelfCorrectionLoop = (raw: unknown): Required<SelfCorrectionLoopConfig> => {
    if (raw === false) {
      return {
        ...defaultHookEnhancements.selfCorrectionLoop,
        enabled: false,
      };
    }
    if (raw === true || raw === undefined) {
      return { ...defaultHookEnhancements.selfCorrectionLoop };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ...defaultHookEnhancements.selfCorrectionLoop };
    }
    const objectRaw = raw as Record<string, unknown>;
    return {
      enabled: objectRaw.enabled !== false,
      minConfidence: typeof objectRaw.minConfidence === "number"
        ? Math.max(0, Math.min(1, objectRaw.minConfidence))
        : defaultHookEnhancements.selfCorrectionLoop.minConfidence,
      suppressTurns: clampInt(parsePositiveInt(objectRaw.suppressTurns) ?? defaultHookEnhancements.selfCorrectionLoop.suppressTurns, 1, 100),
    };
  };

  return {
    tuningPreset,
    embedding: {
      provider: "openai-compatible",
      apiKey,
      model: embedding.model.trim(),
      baseURL: resolveEnvVars(embedding.baseURL.trim()),
      dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions) ?? 2048,
      omitDimensions:
        typeof embedding.omitDimensions === "boolean"
          ? embedding.omitDimensions
          : undefined,
      taskQuery:
        typeof embedding.taskQuery === "string"
          ? embedding.taskQuery
          : undefined,
      taskPassage:
        typeof embedding.taskPassage === "string"
          ? embedding.taskPassage
          : undefined,
      normalized:
        typeof embedding.normalized === "boolean"
          ? embedding.normalized
          : undefined,
      chunking:
        typeof embedding.chunking === "boolean"
          ? embedding.chunking
          : true,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall !== false,
    autoRecallMinLength: parsePositiveInt(cfg.autoRecallMinLength) ?? 6,
    autoRecallMinRepeated: parsePositiveInt(cfg.autoRecallMinRepeated) ?? 8,
    autoRecallMaxItems: parsePositiveInt(cfg.autoRecallMaxItems) ?? 6,
    autoRecallMaxChars: parsePositiveInt(cfg.autoRecallMaxChars) ?? 800,
    autoRecallPerItemMaxChars: parsePositiveInt(cfg.autoRecallPerItemMaxChars) ?? 200,
    autoRecallMaxQueryLength: clampInt(parsePositiveInt(cfg.autoRecallMaxQueryLength) ?? 2_000, 100, 10_000),
    autoRecallCandidatePoolSize: clampInt(parsePositiveInt(cfg.autoRecallCandidatePoolSize) ?? 12, 4, 30),
    autoRecallTimeoutMs: parsePositiveInt(cfg.autoRecallTimeoutMs) ?? 8000,
    maxRecallPerTurn: parsePositiveInt(cfg.maxRecallPerTurn) ?? 10,
    recallMode: (cfg.recallMode === "full" || cfg.recallMode === "summary" || cfg.recallMode === "adaptive" || cfg.recallMode === "off") ? cfg.recallMode : "full",
    autoRecallExcludeAgents: Array.isArray(cfg.autoRecallExcludeAgents)
      ? cfg.autoRecallExcludeAgents
        .filter((id: unknown): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim())
      : undefined,
    autoRecallIncludeAgents: Array.isArray(cfg.autoRecallIncludeAgents)
      ? cfg.autoRecallIncludeAgents
        .filter((id: unknown): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim())
      : undefined,
    captureAssistant: cfg.captureAssistant === true,
    retrieval:
      typeof cfg.retrieval === "object" && cfg.retrieval !== null
        ? (() => {
          const retrieval = { ...(cfg.retrieval as Record<string, unknown>) } as Record<string, unknown>;
          const rerankApiConfigured =
            typeof rawRetrieval?.rerankApiKey === "string" && rawRetrieval.rerankApiKey.trim() !== "";
          const rerankConfigured = retrieval.rerank !== "none" || rerankApiConfigured;
          if (rerankConfigured && typeof retrieval.rerankApiKey === "string" && retrieval.rerankApiKey.includes("${")) {
            retrieval.rerankApiKey = resolveEnvVars(retrieval.rerankApiKey);
          }
          if (rerankApiConfigured) {
            if (typeof retrieval.rerankEndpoint !== "string" || retrieval.rerankEndpoint.trim() === "") {
              throw new Error("retrieval.rerankEndpoint is required when retrieval.rerankApiKey is configured");
            }
            if (typeof retrieval.rerankModel !== "string" || retrieval.rerankModel.trim() === "") {
              throw new Error("retrieval.rerankModel is required when retrieval.rerankApiKey is configured");
            }
          }
          if (rerankConfigured && typeof retrieval.rerankEndpoint === "string" && retrieval.rerankEndpoint.includes("${")) {
            retrieval.rerankEndpoint = resolveEnvVars(retrieval.rerankEndpoint);
          }
          if (rerankConfigured && typeof retrieval.rerankModel === "string" && retrieval.rerankModel.includes("${")) {
            retrieval.rerankModel = resolveEnvVars(retrieval.rerankModel);
          }
          if (rerankConfigured && typeof retrieval.rerankProvider === "string" && retrieval.rerankProvider.includes("${")) {
            retrieval.rerankProvider = resolveEnvVars(retrieval.rerankProvider);
          }
          return retrieval as any;
        })()
        : undefined,
    decay: typeof cfg.decay === "object" && cfg.decay !== null ? cfg.decay as any : undefined,
    tier: typeof cfg.tier === "object" && cfg.tier !== null ? cfg.tier as any : undefined,
    smartExtraction: cfg.smartExtraction !== false,
    llm: (() => {
      const raw = typeof cfg.llm === "object" && cfg.llm !== null ? cfg.llm as Record<string, unknown> : {};
      const apiKeyConfigured = typeof raw.apiKey === "string" && raw.apiKey.trim() !== "";
      const oauthConfigured = raw.auth === "oauth";
      if ((apiKeyConfigured || oauthConfigured) && (typeof raw.baseURL !== "string" || raw.baseURL.trim() === "")) {
        throw new Error("llm.baseURL is required when llm auth/apiKey is configured");
      }
      if ((apiKeyConfigured || oauthConfigured) && (typeof raw.model !== "string" || raw.model.trim() === "")) {
        throw new Error("llm.model is required when llm auth/apiKey is configured");
      }
      return {
        ...raw,
        auth: raw.auth === "oauth" ? "oauth" : "api-key",
        model: typeof raw.model === "string" ? raw.model.trim() : undefined,
        baseURL: typeof raw.baseURL === "string" ? resolveEnvVars(raw.baseURL.trim()) : undefined,
        timeoutMs: parsePositiveInt(raw.timeoutMs) ?? 90000,
      } as any;
    })(),
    extractMinMessages: parsePositiveInt(cfg.extractMinMessages) ?? 5,
    extractMaxChars: parsePositiveInt(cfg.extractMaxChars) ?? 8000,
    scopes: typeof cfg.scopes === "object" && cfg.scopes !== null ? cfg.scopes as any : undefined,
    enableManagementTools: cfg.enableManagementTools !== false,
    sessionStrategy,
    selfImprovement: typeof cfg.selfImprovement === "object" && cfg.selfImprovement !== null
      ? {
        enabled: (cfg.selfImprovement as Record<string, unknown>).enabled !== false,
        beforeResetNote: (cfg.selfImprovement as Record<string, unknown>).beforeResetNote !== false,
        skipSubagentBootstrap: (cfg.selfImprovement as Record<string, unknown>).skipSubagentBootstrap !== false,
        ensureLearningFiles: (cfg.selfImprovement as Record<string, unknown>).ensureLearningFiles !== false,
      }
      : {
        enabled: true,
        beforeResetNote: true,
        skipSubagentBootstrap: true,
        ensureLearningFiles: true,
      },
    memoryReflection: memoryReflectionRaw
      ? {
        enabled: sessionStrategy === "memoryReflection",
        storeToLanceDB: reflectionStoreToLanceDB,
        writeLegacyCombined: memoryReflectionRaw.writeLegacyCombined !== false,
        injectMode: reflectionInjectMode,
        agentId: asNonEmptyString(memoryReflectionRaw.agentId) ?? "main",
        messageCount: reflectionMessageCount,
        maxInputChars: parsePositiveInt(memoryReflectionRaw.maxInputChars) ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS,
        timeoutMs: parsePositiveInt(memoryReflectionRaw.timeoutMs) ?? DEFAULT_REFLECTION_TIMEOUT_MS,
        thinkLevel: (() => {
          const raw = memoryReflectionRaw.thinkLevel;
          if (raw === "off" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
          return DEFAULT_REFLECTION_THINK_LEVEL;
        })(),
        errorReminderMaxEntries: parsePositiveInt(memoryReflectionRaw.errorReminderMaxEntries) ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
        dedupeErrorSignals: memoryReflectionRaw.dedupeErrorSignals !== false,
      }
      : {
        enabled: sessionStrategy === "memoryReflection",
        storeToLanceDB: reflectionStoreToLanceDB,
        writeLegacyCombined: true,
        injectMode: "inheritance+derived",
        agentId: "main",
        messageCount: reflectionMessageCount,
        maxInputChars: DEFAULT_REFLECTION_MAX_INPUT_CHARS,
        timeoutMs: DEFAULT_REFLECTION_TIMEOUT_MS,
        thinkLevel: DEFAULT_REFLECTION_THINK_LEVEL,
        errorReminderMaxEntries: DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
        dedupeErrorSignals: DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS,
      },
    sessionMemory:
      typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
        ? {
          enabled:
            (cfg.sessionMemory as Record<string, unknown>).enabled === true,
          messageCount:
            typeof (cfg.sessionMemory as Record<string, unknown>)
              .messageCount === "number"
              ? ((cfg.sessionMemory as Record<string, unknown>)
                .messageCount as number)
              : undefined,
        }
        : undefined,
    mdMirror:
      typeof cfg.mdMirror === "object" && cfg.mdMirror !== null
        ? {
          enabled:
            (cfg.mdMirror as Record<string, unknown>).enabled === true,
          dir:
            typeof (cfg.mdMirror as Record<string, unknown>).dir === "string"
              ? ((cfg.mdMirror as Record<string, unknown>).dir as string)
              : undefined,
        }
        : undefined,
    workspaceBoundary:
      workspaceBoundaryRaw
        ? {
          userMdExclusive: userMdExclusiveRaw
            ? {
              enabled: userMdExclusiveRaw.enabled === true,
              routeProfile: userMdExclusiveRaw.routeProfile !== false,
              routeCanonicalName: userMdExclusiveRaw.routeCanonicalName !== false,
              routeCanonicalAddressing: userMdExclusiveRaw.routeCanonicalAddressing !== false,
              filterRecall: userMdExclusiveRaw.filterRecall !== false,
            }
            : undefined,
        }
        : undefined,
    admissionControl: normalizeAdmissionControlConfig(cfg.admissionControl),
    memoryCompaction: (() => {
      const raw =
        typeof cfg.memoryCompaction === "object" && cfg.memoryCompaction !== null
          ? (cfg.memoryCompaction as Record<string, unknown>)
          : null;
      return {
        enabled: raw?.enabled !== false,
        minAgeDays: parsePositiveInt(raw?.minAgeDays) ?? 7,
        similarityThreshold:
          typeof raw?.similarityThreshold === "number"
            ? Math.max(0, Math.min(1, raw.similarityThreshold))
            : 0.88,
        minClusterSize: parsePositiveInt(raw?.minClusterSize) ?? 2,
        maxMemoriesToScan: parsePositiveInt(raw?.maxMemoriesToScan) ?? 200,
        cooldownHours: parsePositiveInt(raw?.cooldownHours) ?? 4,
        mergeMode: raw?.mergeMode === "deterministic" ? "deterministic" : "llm",
        deleteSourceMemories: raw?.deleteSourceMemories !== false,
        dryRun: raw?.dryRun === true,
        maxLlmClustersPerRun: parsePositiveInt(raw?.maxLlmClustersPerRun) ?? 10,
      };
    })(),
    lifecycleMaintenance: (() => {
      const raw =
        typeof cfg.lifecycleMaintenance === "object" && cfg.lifecycleMaintenance !== null
          ? (cfg.lifecycleMaintenance as Record<string, unknown>)
          : null;
      const archiveThreshold = typeof raw?.archiveThreshold === "number"
        ? Math.max(0, Math.min(1, raw.archiveThreshold))
        : 0.15;
      return {
        enabled: raw?.enabled !== false,
        cooldownHours: parsePositiveInt(raw?.cooldownHours) ?? 4,
        maxMemoriesToScan: parsePositiveInt(raw?.maxMemoriesToScan) ?? 500,
        archiveThreshold,
        dryRun: raw?.dryRun === true,
        deleteMode: raw?.deleteMode === "delete" ? "delete" : "archive",
        deleteReasons: Array.isArray(raw?.deleteReasons)
          ? raw.deleteReasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
          : ["expired", "superseded", "bad_recall", "stale_unaccessed"],
        hardDeleteReasons: Array.isArray(raw?.hardDeleteReasons)
          ? raw.hardDeleteReasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
          : ["duplicate_cluster_source", "noise", "superseded_fragment"],
      };
    })(),
    preferenceDistiller: (() => {
      const raw =
        typeof cfg.preferenceDistiller === "object" && cfg.preferenceDistiller !== null
          ? (cfg.preferenceDistiller as Record<string, unknown>)
          : null;
      return {
        enabled: raw?.enabled !== false,
        gatewayBackfill: raw?.gatewayBackfill !== false,
        cooldownHours: parsePositiveInt(raw?.cooldownHours) ?? 4,
        maxSessions: clampInt(parsePositiveInt(raw?.maxSessions) ?? 12, 1, 50),
        minEvidenceCount: clampInt(parsePositiveInt(raw?.minEvidenceCount) ?? 2, 1, 10),
        minStabilityScore:
          typeof raw?.minStabilityScore === "number"
            ? Math.max(0, Math.min(1, raw.minStabilityScore))
            : 0.6,
        maxRulesPerRun: clampInt(parsePositiveInt(raw?.maxRulesPerRun) ?? 5, 1, 20),
      };
    })(),
    experienceCompiler: (() => {
      const raw =
        typeof cfg.experienceCompiler === "object" && cfg.experienceCompiler !== null
          ? (cfg.experienceCompiler as Record<string, unknown>)
          : null;
      return {
        enabled: raw?.enabled !== false,
        gatewayBackfill: raw?.gatewayBackfill !== false,
        cooldownHours: parsePositiveInt(raw?.cooldownHours) ?? 4,
        maxStrategiesPerRun: clampInt(parsePositiveInt(raw?.maxStrategiesPerRun) ?? 3, 1, 12),
      };
    })(),
    sessionCompression:
      typeof cfg.sessionCompression === "object" && cfg.sessionCompression !== null
        ? {
            enabled:
              (cfg.sessionCompression as Record<string, unknown>).enabled === true,
            minScoreToKeep:
              typeof (cfg.sessionCompression as Record<string, unknown>).minScoreToKeep === "number"
                ? ((cfg.sessionCompression as Record<string, unknown>).minScoreToKeep as number)
                : 0.3,
          }
        : { enabled: false, minScoreToKeep: 0.3 },
    extractionThrottle:
      typeof cfg.extractionThrottle === "object" && cfg.extractionThrottle !== null
        ? {
            skipLowValue:
              (cfg.extractionThrottle as Record<string, unknown>).skipLowValue === true,
            maxExtractionsPerHour:
              typeof (cfg.extractionThrottle as Record<string, unknown>).maxExtractionsPerHour === "number"
                ? ((cfg.extractionThrottle as Record<string, unknown>).maxExtractionsPerHour as number)
                : 0,
          }
        : { skipLowValue: false, maxExtractionsPerHour: 0 },
    feedbackLoop: normalizeFeedbackLoopConfig(cfg.feedbackLoop),
    recallPrefix:
      typeof cfg.recallPrefix === "object" && cfg.recallPrefix !== null
        ? {
            categoryField:
              typeof (cfg.recallPrefix as Record<string, unknown>).categoryField === "string"
                ? ((cfg.recallPrefix as Record<string, unknown>).categoryField as string)
                : undefined,
          }
        : undefined,
    telemetry: normalizeTelemetryConfig(cfg.telemetry),
    hookEnhancements: hookEnhancementsRaw
      ? {
          badRecallFeedback: hookEnhancementsRaw.badRecallFeedback !== false,
          correctionDiff: hookEnhancementsRaw.correctionDiff !== false,
          toolErrorPlaybook: hookEnhancementsRaw.toolErrorPlaybook !== false,
          dangerousToolHints: hookEnhancementsRaw.dangerousToolHints !== false,
          contextBudget: hookEnhancementsRaw.contextBudget !== false,
          privacyGuard: hookEnhancementsRaw.privacyGuard !== false,
          sessionPrimer: normalizeSessionPrimer(hookEnhancementsRaw.sessionPrimer),
          selfCorrectionLoop: normalizeSelfCorrectionLoop(hookEnhancementsRaw.selfCorrectionLoop),
          workspaceDrift: hookEnhancementsRaw.workspaceDrift !== false,
          stalenessConfirmation: hookEnhancementsRaw.stalenessConfirmation !== false,
        }
      : defaultHookEnhancements,
  };
}
