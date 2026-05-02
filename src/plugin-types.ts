/**
 * Plugin Types
 *
 * Core type definitions for the memory plugin.
 */

import type { WorkspaceBoundaryConfig } from "./workspace-boundary.js";
import type { AdmissionControlConfig } from "./admission-control.js";
import type { TuningPreset } from "./tuning-presets.js";

export interface PluginConfig {
  tuningPreset?: TuningPreset;
  embedding: {
    provider: "openai-compatible" | "azure-openai";
    apiVersion?: string;
    apiKey: string | string[];
    model?: string;
    baseURL?: string;
    dimensions?: number;
    omitDimensions?: boolean;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMinRepeated?: number;
  autoRecallTimeoutMs?: number;
  /** Soft auto-recall degradation threshold. Default: 5000ms; hard timeout is autoRecallTimeoutMs. */
  autoRecallDegradeAfterMs?: number;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  autoRecallPerItemMaxChars?: number;
  /** Max query string length before embedding search (safety valve). Default: 2000, range: 100-10000. */
  autoRecallMaxQueryLength?: number;
  /** Candidate pool cap for auto-recall retrieval. Default: 8, range: 4-20. */
  autoRecallCandidatePoolSize?: number;
  /** Hard per-turn injection cap (safety valve). Overrides autoRecallMaxItems if lower. Default: 10. */
  maxRecallPerTurn?: number;
  recallMode?: "full" | "summary" | "adaptive" | "off";
  /** Agent IDs excluded from auto-recall injection. Useful for background agents. */
  autoRecallExcludeAgents?: string[];
  /** Agent IDs included in auto-recall injection (whitelist mode). */
  autoRecallIncludeAgents?: string[];
  captureAssistant?: boolean;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    queryExpansion?: boolean;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankTimeoutMs?: number;
    rerankProvider?:
      | "jina"
      | "siliconflow"
      | "voyage"
      | "pinecone"
      | "dashscope"
      | "tei";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
    tagPrefixes?: string[];
  };
  decay?: {
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    frequencyWeight?: number;
    intrinsicWeight?: number;
    staleThreshold?: number;
    searchBoostMin?: number;
    importanceModulation?: number;
    betaCore?: number;
    betaWorking?: number;
    betaPeripheral?: number;
    coreDecayFloor?: number;
    workingDecayFloor?: number;
    peripheralDecayFloor?: number;
    knowledgeHalfLifeMultiplier?: number;
    experienceHalfLifeMultiplier?: number;
  };
  tier?: {
    coreAccessThreshold?: number;
    coreCompositeThreshold?: number;
    coreImportanceThreshold?: number;
    peripheralCompositeThreshold?: number;
    peripheralAgeDays?: number;
    workingAccessThreshold?: number;
    workingCompositeThreshold?: number;
  };
  smartExtraction?: boolean;
  llm?: {
    auth?: "api-key" | "oauth";
    apiKey?: string;
    model?: string;
    baseURL?: string;
    oauthProvider?: string;
    oauthPath?: string;
    timeoutMs?: number;
  };
  extractMinMessages?: number;
  extractMaxChars?: number;
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionMemory?: { enabled?: boolean; messageCount?: number };
  selfImprovement?: {
    enabled?: boolean;
    beforeResetNote?: boolean;
    skipSubagentBootstrap?: boolean;
    ensureLearningFiles?: boolean;
  };
  memoryReflection?: {
    enabled?: boolean;
    storeToLanceDB?: boolean;
    writeLegacyCombined?: boolean;
    injectMode?: ReflectionInjectMode;
    agentId?: string;
    messageCount?: number;
    maxInputChars?: number;
    timeoutMs?: number;
    thinkLevel?: ReflectionThinkLevel;
    errorReminderMaxEntries?: number;
    dedupeErrorSignals?: boolean;
  };
  mdMirror?: { enabled?: boolean; dir?: string };
  workspaceBoundary?: WorkspaceBoundaryConfig;
  admissionControl?: AdmissionControlConfig;
  memoryCompaction?: {
    enabled?: boolean;
    minAgeDays?: number;
    similarityThreshold?: number;
    minClusterSize?: number;
    maxMemoriesToScan?: number;
    cooldownHours?: number;
    mergeMode?: "llm" | "deterministic";
    deleteSourceMemories?: boolean;
    dryRun?: boolean;
    maxLlmClustersPerRun?: number;
  };
  lifecycleMaintenance?: {
    enabled?: boolean;
    cooldownHours?: number;
    maxMemoriesToScan?: number;
    archiveThreshold?: number;
    dryRun?: boolean;
    deleteMode?: "delete" | "archive";
    deleteReasons?: string[];
    hardDeleteReasons?: string[];
  };
  preferenceDistiller?: PreferenceDistillerConfig;
  experienceCompiler?: ExperienceCompilerConfig;
  sessionCompression?: {
    enabled?: boolean;
    minScoreToKeep?: number;
  };
  extractionThrottle?: {
    skipLowValue?: boolean;
    maxExtractionsPerHour?: number;
  };
  feedbackLoop?: {
    enabled?: boolean;
    noiseLearning?: {
      fromErrors?: boolean;
      fromRejections?: boolean;
      minRejectionsForScan?: number;
      scanIntervalMs?: number;
      maxLearnPerScan?: number;
      relearnCooldownMs?: number;
      errorAreas?: string[];
    };
    priorAdaptation?: {
      enabled?: boolean;
      adaptationIntervalMs?: number;
      minObservations?: number;
      learningRate?: number;
      maxAdjustment?: number;
      observationWindowMs?: number;
      maxRejectionAudits?: number;
    };
  };
  recallPrefix?: {
    categoryField?: string;
  };
  telemetry?: {
    persist: boolean;
    dir?: string;
    maxRecords: number;
    sampleRate: number;
  };
  hookEnhancements?: HookEnhancementsConfig;
}

export interface HookEnhancementsConfig {
  badRecallFeedback?: boolean;
  correctionDiff?: boolean;
  toolErrorPlaybook?: boolean;
  dangerousToolHints?: boolean;
  contextBudget?: boolean;
  privacyGuard?: boolean;
  sessionPrimer?: boolean | SessionPrimerConfig;
  selfCorrectionLoop?: boolean | SelfCorrectionLoopConfig;
  workspaceDrift?: boolean;
  stalenessConfirmation?: boolean;
}

export interface SessionPrimerConfig {
  enabled?: boolean;
  preferDistilled?: boolean;
  includeReflectionInvariants?: boolean;
  maxItems?: number;
  maxChars?: number;
}

export interface SelfCorrectionLoopConfig {
  enabled?: boolean;
  minConfidence?: number;
  suppressTurns?: number;
}

export interface PreferenceDistillerConfig {
  enabled?: boolean;
  gatewayBackfill?: boolean;
  cooldownHours?: number;
  maxSessions?: number;
  minEvidenceCount?: number;
  minStabilityScore?: number;
  maxRulesPerRun?: number;
}

export interface ExperienceCompilerConfig {
  enabled?: boolean;
  gatewayBackfill?: boolean;
  cooldownHours?: number;
  maxStrategiesPerRun?: number;
}

export type ReflectionThinkLevel = "off" | "minimal" | "low" | "medium" | "high";
export type SessionStrategy = "memoryReflection" | "systemSessionMemory" | "none";
export type ReflectionInjectMode = "inheritance-only" | "inheritance+derived";

export interface ReflectionErrorSignal {
  at: number;
  toolName: string;
  summary: string;
  source: "tool_error" | "tool_output";
  signature: string;
  signatureHash: string;
}

export interface ReflectionErrorState {
  entries: ReflectionErrorSignal[];
  lastInjectedCount: number;
  signatureSet: Set<string>;
  updatedAt: number;
}

export type EmbeddedPiRunner = (params: Record<string, unknown>) => Promise<unknown>;

export interface AdmissionRejectionAuditEntry {
  rejectedAt: number;
  text: string;
  reason: string;
  decayScore: number;
  threshold: number;
  thresholdAdapted: boolean;
}

export interface AgentWorkspaceMap {
  [agentId: string]: string;
}
