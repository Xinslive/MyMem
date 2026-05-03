import type { ReflectionMappedMemoryItem } from "./reflection-slices.js";
import {
  buildReasoningStrategyFields,
  type ReasoningStrategyFields,
} from "./reasoning-strategy.js";

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";
export type ReflectionMappedCategory = "preference" | "fact" | "decision";

export interface ReflectionMappedMetadata {
  type: "memory-reflection-mapped";
  reflectionVersion: 4;
  stage: "reflect-store";
  memory_category: "patterns";
  eventId: string;
  mappedKind: ReflectionMappedKind;
  mappedCategory: ReflectionMappedCategory;
  section: string;
  ordinal: number;
  groupSize: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storedAt: number;
  usedFallback: boolean;
  errorSignals: string[];
  decayModel: "logistic";
  decayMidpointDays: number;
  decayK: number;
  baseWeight: number;
  quality: number;
  reasoning_strategy?: ReasoningStrategyFields["reasoning_strategy"];
  strategy_kind?: ReasoningStrategyFields["strategy_kind"];
  outcome?: ReasoningStrategyFields["outcome"];
  strategy_title?: ReasoningStrategyFields["strategy_title"];
  strategy_summary?: ReasoningStrategyFields["strategy_summary"];
  strategy_steps?: ReasoningStrategyFields["strategy_steps"];
  strategy_description?: ReasoningStrategyFields["strategy_description"];
  failure_mode?: ReasoningStrategyFields["failure_mode"];
  prevention?: ReasoningStrategyFields["prevention"];
  success_signal?: ReasoningStrategyFields["success_signal"];
  sourceReflectionPath?: string;
}

export interface ReflectionMappedDecayDefaults {
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
}

const REFLECTION_MAPPED_DECAY_DEFAULTS: Record<ReflectionMappedKind, ReflectionMappedDecayDefaults> = {
  decision: { midpointDays: 45, k: 0.25, baseWeight: 1.1, quality: 1 },
  "user-model": { midpointDays: 21, k: 0.3, baseWeight: 1, quality: 0.95 },
  "agent-model": { midpointDays: 10, k: 0.35, baseWeight: 0.95, quality: 0.93 },
  lesson: { midpointDays: 7, k: 0.45, baseWeight: 0.9, quality: 0.9 },
};

export function getReflectionMappedDecayDefaults(kind: ReflectionMappedKind): ReflectionMappedDecayDefaults {
  return REFLECTION_MAPPED_DECAY_DEFAULTS[kind];
}

export function buildReflectionMappedMetadata(params: {
  mappedItem: ReflectionMappedMemoryItem;
  eventId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runAt: number;
  usedFallback: boolean;
  toolErrorSignals: Array<{ signatureHash: string }>;
  sourceReflectionPath?: string;
}): ReflectionMappedMetadata {
  const defaults = getReflectionMappedDecayDefaults(params.mappedItem.mappedKind);
  const reasoningStrategy =
    params.mappedItem.mappedKind === "lesson" || params.mappedItem.mappedKind === "agent-model";
  const reasoningStrategyFields = reasoningStrategy
    ? buildReasoningStrategyFields({
        kind: params.mappedItem.mappedKind === "lesson" ? "preventive" : "validated",
        outcome: params.mappedItem.mappedKind === "lesson" ? "failure" : "success",
        title: params.mappedItem.text,
        steps: params.mappedItem.text,
        description: params.mappedItem.heading,
        failureMode: params.mappedItem.mappedKind === "lesson" ? params.mappedItem.text : undefined,
        prevention: params.mappedItem.mappedKind === "lesson" ? params.mappedItem.text : undefined,
        successSignal: params.mappedItem.mappedKind === "agent-model" ? params.mappedItem.text : undefined,
      })
    : null;
  return {
    type: "memory-reflection-mapped",
    reflectionVersion: 4,
    stage: "reflect-store",
    memory_category: "patterns", // All reflection-mapped memories belong to patterns category
    eventId: params.eventId,
    mappedKind: params.mappedItem.mappedKind,
    mappedCategory: params.mappedItem.category,
    section: params.mappedItem.heading,
    ordinal: params.mappedItem.ordinal,
    groupSize: params.mappedItem.groupSize,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storedAt: params.runAt,
    usedFallback: params.usedFallback,
    errorSignals: params.toolErrorSignals.map((signal) => signal.signatureHash),
    decayModel: "logistic",
    decayMidpointDays: defaults.midpointDays,
    decayK: defaults.k,
    baseWeight: defaults.baseWeight,
    quality: defaults.quality,
    ...(reasoningStrategyFields ?? {}),
    ...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
  };
}
