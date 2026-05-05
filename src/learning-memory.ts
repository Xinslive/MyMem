import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import type { LlmClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import type { LearningMemoryConfig } from "./plugin-types.js";
import type { RetrievalResult } from "./retriever-types.js";
import type { LearningScoreBreakdown } from "./retriever-types.js";
import {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import type { MemoryCategory } from "./memory-categories.js";

export type NormalizedLearningMemoryConfig = Required<LearningMemoryConfig> & {
  sceneMemory: Required<NonNullable<LearningMemoryConfig["sceneMemory"]>>;
  utilityLearning: Required<NonNullable<LearningMemoryConfig["utilityLearning"]>>;
  exploration: Required<NonNullable<LearningMemoryConfig["exploration"]>>;
  casePatternDistillation: Required<NonNullable<LearningMemoryConfig["casePatternDistillation"]>>;
};

export interface LearningMemoryResult extends RetrievalResult {
  sources: RetrievalResult["sources"] & {
    learning?: LearningScoreBreakdown;
  };
}

export interface LearningMaintenanceResult {
  scanned: number;
  scenesCreated: number;
  scenesUpdated: number;
  patternsCreated: number;
  utilitySmoothed: number;
  skipped: number;
  llmRefined: number;
  fallbackUsed: number;
}

type LearningStore = Pick<MemoryStore, "list" | "store" | "update"> &
  Partial<Pick<MemoryStore, "patchMetadataBatch">>;

type SceneClusterDraft = {
  key: string;
  members: MemoryEntry[];
  title?: string;
  summary?: string;
};

const DEFAULT_CONFIG: NormalizedLearningMemoryConfig = {
  enabled: true,
  sceneMemory: {
    enabled: true,
    maxScenesPerRun: 8,
    maxSceneMembers: 8,
    maxExpandedSceneMembers: 2,
  },
  utilityLearning: {
    enabled: true,
    positiveReward: 0.12,
    negativeReward: 0.18,
    smoothing: 0.25,
  },
  exploration: {
    enabled: true,
    weight: 0.08,
    minTrialsBeforeDecay: 3,
  },
  casePatternDistillation: {
    enabled: true,
    minCaseClusterSize: 2,
    maxPatternsPerRun: 4,
  },
  llmQuality: "high",
  cooldownHours: 4,
  maxMemoriesToScan: 300,
};

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeLearningMemoryConfig(
  config?: LearningMemoryConfig,
): NormalizedLearningMemoryConfig {
  return {
    enabled: config?.enabled !== false,
    sceneMemory: {
      enabled: config?.sceneMemory?.enabled !== false,
      maxScenesPerRun: positiveInt(config?.sceneMemory?.maxScenesPerRun, DEFAULT_CONFIG.sceneMemory.maxScenesPerRun, 1, 50),
      maxSceneMembers: positiveInt(config?.sceneMemory?.maxSceneMembers, DEFAULT_CONFIG.sceneMemory.maxSceneMembers, 2, 24),
      maxExpandedSceneMembers: positiveInt(config?.sceneMemory?.maxExpandedSceneMembers, DEFAULT_CONFIG.sceneMemory.maxExpandedSceneMembers, 0, 5),
    },
    utilityLearning: {
      enabled: config?.utilityLearning?.enabled !== false,
      positiveReward: clamp01(config?.utilityLearning?.positiveReward, DEFAULT_CONFIG.utilityLearning.positiveReward),
      negativeReward: clamp01(config?.utilityLearning?.negativeReward, DEFAULT_CONFIG.utilityLearning.negativeReward),
      smoothing: Math.max(0.01, clamp01(config?.utilityLearning?.smoothing, DEFAULT_CONFIG.utilityLearning.smoothing)),
    },
    exploration: {
      enabled: config?.exploration?.enabled !== false,
      weight: Math.min(0.5, clamp01(config?.exploration?.weight, DEFAULT_CONFIG.exploration.weight)),
      minTrialsBeforeDecay: positiveInt(config?.exploration?.minTrialsBeforeDecay, DEFAULT_CONFIG.exploration.minTrialsBeforeDecay, 0, 50),
    },
    casePatternDistillation: {
      enabled: config?.casePatternDistillation?.enabled !== false,
      minCaseClusterSize: positiveInt(config?.casePatternDistillation?.minCaseClusterSize, DEFAULT_CONFIG.casePatternDistillation.minCaseClusterSize, 2, 20),
      maxPatternsPerRun: positiveInt(config?.casePatternDistillation?.maxPatternsPerRun, DEFAULT_CONFIG.casePatternDistillation.maxPatternsPerRun, 1, 20),
    },
    llmQuality: config?.llmQuality === "low" || config?.llmQuality === "medium" || config?.llmQuality === "high"
      ? config.llmQuality
      : DEFAULT_CONFIG.llmQuality,
    cooldownHours: positiveInt(config?.cooldownHours, DEFAULT_CONFIG.cooldownHours, 1, 168),
    maxMemoriesToScan: positiveInt(config?.maxMemoriesToScan, DEFAULT_CONFIG.maxMemoriesToScan, 20, 2000),
  };
}

export function applyLearningPolicy(
  results: RetrievalResult[],
  config?: LearningMemoryConfig,
): LearningMemoryResult[] {
  const cfg = normalizeLearningMemoryConfig(config);
  if (!cfg.enabled) return results as LearningMemoryResult[];

  const totalTrials = results.reduce((sum, result) => {
    const meta = result.entry._parsedMeta ?? parseSmartMetadata(result.entry.metadata, result.entry);
    return sum + Math.max(0, Number(meta.utility_trial_count || 0));
  }, 0);
  const logTrials = Math.log1p(Math.max(totalTrials, results.length));

  return results
    .map((result) => {
      const meta = result.entry._parsedMeta ?? parseSmartMetadata(result.entry.metadata, result.entry);
      const utility = clamp01(meta.utility_score, 0.5);
      const trialCount = Math.max(0, Number(meta.utility_trial_count || 0));
      const badRecallCount = Math.max(0, Number(meta.bad_recall_count || 0));
      const utilityBoost = cfg.utilityLearning.enabled ? (utility - 0.5) * 0.24 : 0;
      const explorationBoost = cfg.exploration.enabled
        ? cfg.exploration.weight * Math.sqrt(logTrials / Math.max(1, trialCount + 1))
        : 0;
      const sceneBoost = meta.memory_kind === "scene" ? 0.04 : meta.scene_id || meta.scene_key ? 0.02 : 0;
      const badRecallPenalty = Math.min(0.35, badRecallCount * 0.08);
      const finalScore = Math.max(0, result.score + utilityBoost + explorationBoost + sceneBoost - badRecallPenalty);
      const breakdown: LearningScoreBreakdown = {
        originalScore: result.score,
        utility,
        utilityBoost,
        explorationBoost,
        sceneBoost,
        badRecallPenalty,
        finalScore,
      };
      return {
        ...result,
        score: finalScore,
        sources: {
          ...result.sources,
          learning: breakdown,
        },
      } as LearningMemoryResult;
    })
    .sort((a, b) => b.score - a.score);
}

export function buildUtilityPatch(
  metadata: SmartMemoryMetadata,
  signal: "positive" | "negative",
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  const cfg = normalizeLearningMemoryConfig(config);
  const current = clamp01(metadata.utility_score, 0.5);
  const success = Math.max(0, Number(metadata.utility_success_count || 0));
  const failure = Math.max(0, Number(metadata.utility_failure_count || 0));
  const reward = signal === "positive" ? cfg.utilityLearning.positiveReward : -cfg.utilityLearning.negativeReward;
  const target = signal === "positive" ? 1 : 0;
  const moved = current * (1 - cfg.utilityLearning.smoothing) + target * cfg.utilityLearning.smoothing;
  const adjusted = clamp01(moved + reward * 0.25, current);
  return {
    utility_score: adjusted,
    utility_success_count: signal === "positive" ? success + 1 : success,
    utility_failure_count: signal === "negative" ? failure + 1 : failure,
    utility_trial_count: Math.max(0, Number(metadata.utility_trial_count || 0)) + 1,
    last_utility_update_at: at,
  };
}

export function buildUtilitySmoothingPatch(
  metadata: SmartMemoryMetadata,
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  const cfg = normalizeLearningMemoryConfig(config);
  const success = Math.max(0, Number(metadata.utility_success_count || 0));
  const failure = Math.max(0, Number(metadata.utility_failure_count || 0));
  const trials = success + failure;
  if (trials === 0) return {};
  const observed = success / trials;
  const current = clamp01(metadata.utility_score, 0.5);
  const adjusted = clamp01(
    current * (1 - cfg.utilityLearning.smoothing) + observed * cfg.utilityLearning.smoothing,
    current,
  );
  return {
    utility_score: adjusted,
    utility_trial_count: Math.max(Number(metadata.utility_trial_count || 0), trials),
    last_utility_update_at: at,
  };
}

export function buildPositiveUtilityMetadataPatch(
  metadata: SmartMemoryMetadata,
  config?: LearningMemoryConfig,
  at = Date.now(),
): Record<string, unknown> {
  if (config?.enabled === false) return {};
  return {
    last_confirmed_use_at: at,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
    ...buildUtilityPatch(metadata, "positive", config, at),
  };
}

export function formatSceneLine(entry: MemoryEntry, maxChars: number): string {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const title = meta.scene_title || meta.summary || "Memory scene";
  const body = meta.content || entry.text;
  return `- [scene:${entry.scope}] ${title}: ${body}`.slice(0, maxChars).trim();
}

export function formatSceneExpandedLine(
  entry: MemoryEntry,
  members: MemoryEntry[],
  maxChars: number,
): string {
  const base = formatSceneLine(entry, maxChars);
  const expansion = members
    .map((member) => {
      const memberMeta = parseSmartMetadata(member.metadata, member);
      return memberMeta.summary || member.text;
    })
    .filter(Boolean)
    .slice(0, 5)
    .map((text) => `member: ${text}`)
    .join(" | ");
  if (!expansion) return base;
  return `${base} | ${expansion}`.slice(0, maxChars).trim();
}

export function pickHighValueSceneMembers(
  sceneMeta: SmartMemoryMetadata,
  entriesById: Map<string, MemoryEntry>,
  maxMembers: number,
): MemoryEntry[] {
  if (maxMembers <= 0 || !sceneMeta.scene_member_ids?.length) return [];
  return sceneMeta.scene_member_ids
    .map((id) => entriesById.get(id))
    .filter((entry): entry is MemoryEntry => {
      if (!entry) return false;
      const meta = parseSmartMetadata(entry.metadata, entry);
      return meta.state === "confirmed" && meta.memory_layer !== "archive";
    })
    .sort((a, b) => {
      const metaA = parseSmartMetadata(a.metadata, a);
      const metaB = parseSmartMetadata(b.metadata, b);
      const utilityA = Number(metaA.utility_score || 0.5);
      const utilityB = Number(metaB.utility_score || 0.5);
      return utilityB - utilityA || b.importance - a.importance || b.timestamp - a.timestamp;
    })
    .slice(0, maxMembers);
}

function memoryKindForCategory(category: MemoryCategory): SmartMemoryMetadata["memory_kind"] {
  if (category === "cases") return "case";
  if (category === "patterns") return "pattern";
  return "memory";
}

export function defaultLearningKindPatch(category: MemoryCategory): Record<string, unknown> {
  return {
    memory_kind: memoryKindForCategory(category),
    utility_score: 0.5,
    utility_success_count: 0,
    utility_failure_count: 0,
    utility_trial_count: 0,
  };
}

function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[`"'“”‘’()[\]{}]/g, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTopic(entry: MemoryEntry, meta: SmartMemoryMetadata): string {
  const candidates = [
    meta.scene_key,
    meta.fact_key,
    meta.canonical_id,
    meta.case_trigger,
    meta.summary,
    entry.text,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const raw = candidates[0] ?? entry.id;
  const cjk = raw.match(/[\u4e00-\u9fff]{2,12}/);
  if (cjk) return `${entry.scope}:${meta.memory_category}:${cjk[0]}`;
  const words = normalizeTopic(raw)
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(the|and|for|with|this|that|memory|user|agent)$/.test(word))
    .slice(0, 5);
  return `${entry.scope}:${meta.memory_category}:${words.join(" ") || raw.slice(0, 32)}`;
}

function normalizeClusterFragment(text: string, maxWords = 5): string {
  const words = normalizeTopic(text)
    .split(/\s+/)
    .filter((word) => word.length > 1 && !/^(the|and|for|with|this|that|memory|user|agent)$/.test(word))
    .slice(0, maxWords);
  return words.join(" ").slice(0, 80);
}

function pushAxis(axes: string[], kind: string, value: unknown, maxWords = 5): void {
  if (typeof value !== "string" || !value.trim()) return;
  const normalized = normalizeClusterFragment(value, maxWords);
  if (normalized) axes.push(`${kind}:${normalized}`);
}

function inferSceneAxes(entry: MemoryEntry, meta: SmartMemoryMetadata): string[] {
  const text = [
    meta.summary,
    meta.case_trigger,
    meta.canonical_id,
    meta.fact_key,
    entry.text,
  ].filter(Boolean).join(" ");
  const axes: string[] = [];

  pushAxis(axes, "topic", meta.fact_key || meta.canonical_id || meta.case_trigger || meta.summary, 6);

  const projectMatch =
    text.match(/\b(?:project|proj|repo|workspace|service|app)\s*[:#-]?\s*([A-Za-z0-9][\w./-]{1,48})/i) ||
    text.match(/(?:项目|仓库|服务|应用)[：:\s]+([A-Za-z0-9_\-./\u4e00-\u9fff]{2,48})/u);
  if (projectMatch?.[1]) pushAxis(axes, "project", projectMatch[1], 4);

  const personMatch =
    text.match(/\b(?:for|with|from|by)\s+([A-Z][a-zA-Z]{2,30})\b/) ||
    text.match(/(?:用户|客户|同事|负责人|owner)[：:\s]+([A-Za-z0-9_\-\u4e00-\u9fff]{2,32})/u);
  if (personMatch?.[1]) pushAxis(axes, "person", personMatch[1], 3);

  if (/\b(test|verify|regression|lint|typecheck|ci|failure|bug|fix|debug)\b/i.test(text) || /测试|验证|回归|失败|修复|调试/.test(text)) {
    axes.push("workflow:verification-debugging");
  }
  if (/\b(deploy|release|migration|rollback|production|build)\b/i.test(text) || /部署|发布|迁移|回滚|生产/.test(text)) {
    axes.push("workflow:delivery");
  }
  if (/\b(prompt|extract|recall|memory|reflection|retrieval|embedding)\b/i.test(text) || /记忆|召回|提取|反思|嵌入/.test(text)) {
    axes.push("workflow:memory-system");
  }
  if (/\b(goal|objective|avoid|prevent|ensure|prefer|policy)\b/i.test(text) || /目标|避免|确保|偏好|策略/.test(text)) {
    axes.push("goal:" + normalizeClusterFragment(meta.summary || entry.text, 7));
  }

  const month = new Date(entry.timestamp || Date.now()).toISOString().slice(0, 7);
  axes.push(`period:${month}`);
  return [...new Set(axes)];
}

function buildDeterministicSceneClusters(entries: MemoryEntry[]): SceneClusterDraft[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    const axes = inferSceneAxes(entry, meta);
    const discriminating = axes.filter((axis) => !axis.startsWith("period:"));
    const period = axes.find((axis) => axis.startsWith("period:"));
    const keys = new Set<string>();

    const project = discriminating.find((axis) => axis.startsWith("project:"));
    const person = discriminating.find((axis) => axis.startsWith("person:"));
    const workflow = discriminating.find((axis) => axis.startsWith("workflow:"));
    const goal = discriminating.find((axis) => axis.startsWith("goal:"));
    const topic = discriminating.find((axis) => axis.startsWith("topic:"));

    if (project && workflow) keys.add(`${entry.scope}:${meta.memory_category}:${project}|${workflow}`);
    if (person && project) keys.add(`${entry.scope}:${meta.memory_category}:${person}|${project}`);
    if (goal && workflow) keys.add(`${entry.scope}:${meta.memory_category}:${goal}|${workflow}`);
    if (topic) keys.add(`${entry.scope}:${meta.memory_category}:${topic}`);
    if (workflow && period) keys.add(`${entry.scope}:${meta.memory_category}:${workflow}|${period}`);
    keys.add(extractTopic(entry, meta));

    for (const key of keys) {
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
  }

  return [...groups.entries()]
    .map(([key, members]) => ({ key, members }))
    .filter((group) => group.members.length >= 2)
    .sort((a, b) => {
      const score = (group: SceneClusterDraft) =>
        group.members.length * 10 +
        group.members.reduce((sum, entry) => sum + entry.importance, 0);
      return score(b) - score(a);
    });
}

function stableId(prefix: string, key: string): string {
  return `${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function toStoreCategory(category: MemoryCategory): MemoryEntry["category"] {
  switch (category) {
    case "preferences": return "preference";
    case "entities": return "entity";
    case "events": return "decision";
    case "patterns": return "other";
    case "profile":
    case "cases":
      return "fact";
  }
}

function summarizeMembers(members: MemoryEntry[], maxMembers: number): string {
  return members.slice(0, maxMembers).map((entry) => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    return `- ${meta.summary || entry.text}`;
  }).join("\n");
}

async function refineSceneTitle(
  llm: LlmClient | undefined,
  members: MemoryEntry[],
  fallback: { title: string; summary: string },
): Promise<{ title: string; summary: string } | null> {
  if (!llm) return null;
  const prompt = [
    "You organize long-term agent memory into one reusable memory scene.",
    "Return only JSON with keys: title, summary.",
    "title must be concise. summary must be a compact bullet-style synthesis useful for future recall.",
    "Use Simplified Chinese for ordinary prose; keep code identifiers and proper nouns unchanged.",
    "",
    summarizeMembers(members, 10),
  ].join("\n");
  const raw = await llm.completeJson<unknown>(prompt, "learning-memory-scene");
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : fallback.title;
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : fallback.summary;
  return { title, summary };
}

async function clusterScenesWithLlm(
  llm: LlmClient | undefined,
  entries: MemoryEntry[],
  maxScenes: number,
): Promise<SceneClusterDraft[] | null> {
  if (!llm || entries.length < 2) return null;
  const candidates = entries.slice(0, 80).map((entry) => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    return {
      id: entry.id,
      scope: entry.scope,
      category: meta.memory_category,
      abstract: meta.summary || entry.text,
      project: meta.project || meta.repo || meta.workspace,
      person: meta.person || meta.user || meta.owner,
      goal: meta.goal || meta.objective,
      workflow: meta.workflow || meta.case_trigger,
      period: new Date(entry.timestamp || Date.now()).toISOString().slice(0, 7),
    };
  });
  const prompt = [
    "Cluster memory candidates into reusable scenes.",
    "Use multiple dimensions together: people, projects, long-term goals, time period, and workflow scenario.",
    "Return only JSON with key scenes. scenes must be an array of objects: key, title, summary, member_ids.",
    `Create at most ${maxScenes} scenes. Each scene needs at least 2 member_ids from the provided ids.`,
    "Use Simplified Chinese for ordinary prose; keep code identifiers and proper nouns unchanged.",
    "",
    JSON.stringify(candidates),
  ].join("\n");
  const raw = await llm.completeJson<unknown>(prompt, "learning-memory-scene-cluster");
  if (!raw || typeof raw !== "object") return null;
  const scenes = (raw as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return null;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const drafts: SceneClusterDraft[] = [];
  const seenKeys = new Set<string>();
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    const obj = scene as Record<string, unknown>;
    const memberIds = Array.isArray(obj.member_ids)
      ? obj.member_ids.filter((id): id is string => typeof id === "string")
      : [];
    const members = memberIds.map((id) => byId.get(id)).filter((entry): entry is MemoryEntry => !!entry);
    if (members.length < 2) continue;
    const rawKey = typeof obj.key === "string" && obj.key.trim()
      ? obj.key.trim()
      : members.map((entry) => entry.id).sort().join("|");
    const key = `${members[0].scope}:${parseSmartMetadata(members[0].metadata, members[0]).memory_category}:llm:${normalizeClusterFragment(rawKey, 10) || stableId("cluster", rawKey)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    drafts.push({
      key,
      members,
      title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined,
      summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : undefined,
    });
    if (drafts.length >= maxScenes) break;
  }
  return drafts.length > 0 ? drafts : null;
}

async function refinePattern(
  llm: LlmClient | undefined,
  cases: MemoryEntry[],
  fallback: { title: string; content: string; steps: string[] },
): Promise<{ title: string; content: string; steps: string[] } | null> {
  if (!llm) return null;
  const prompt = [
    "Distill repeated successful or failed agent cases into one reusable pattern.",
    "Return only JSON with keys: title, content, steps.",
    "steps must be an array of concrete action steps.",
    "Use Simplified Chinese for ordinary prose; keep commands, paths, APIs, and code identifiers unchanged.",
    "",
    summarizeMembers(cases, 12),
  ].join("\n");
  const raw = await llm.completeJson<unknown>(prompt, "learning-memory-pattern");
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : fallback.title;
  const content = typeof obj.content === "string" && obj.content.trim() ? obj.content.trim() : fallback.content;
  const steps = Array.isArray(obj.steps)
    ? obj.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0).slice(0, 8)
    : fallback.steps;
  return { title, content, steps: steps.length > 0 ? steps : fallback.steps };
}

export async function runLearningMemoryMaintenance(
  deps: {
    store: LearningStore;
    embedder: Pick<Embedder, "embedPassage">;
    llm?: LlmClient | null;
    logger?: Pick<Logger, "info" | "warn" | "debug">;
  },
  config?: LearningMemoryConfig,
  scopeFilter?: string[],
): Promise<LearningMaintenanceResult> {
  const cfg = normalizeLearningMemoryConfig(config);
  const result: LearningMaintenanceResult = {
    scanned: 0,
    scenesCreated: 0,
    scenesUpdated: 0,
    patternsCreated: 0,
    utilitySmoothed: 0,
    skipped: 0,
    llmRefined: 0,
    fallbackUsed: 0,
  };
  if (!cfg.enabled) return result;

  const rows = await deps.store.list(scopeFilter, undefined, cfg.maxMemoriesToScan, 0);
  result.scanned = rows.length;
  const active = rows.filter((entry) => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    return meta.state !== "archived" && meta.memory_layer !== "archive" && meta.source !== "session-summary";
  });
  const existingScenes = new Map<string, MemoryEntry>();
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of active) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.memory_kind === "scene" && meta.scene_key) {
      existingScenes.set(meta.scene_key, entry);
      continue;
    }
    const key = extractTopic(entry, meta);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  if (cfg.sceneMemory.enabled) {
    const deterministicSceneGroups = buildDeterministicSceneClusters(
      [...groups.values()].flat(),
    );
    const llmSceneGroups = await clusterScenesWithLlm(
      deps.llm ?? undefined,
      [...groups.values()].flat()
        .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp),
      cfg.sceneMemory.maxScenesPerRun,
    );
    if (llmSceneGroups) result.llmRefined++;
    const seenSceneKeys = new Set<string>();
    const sceneGroups = [
      ...(llmSceneGroups ?? []),
      ...deterministicSceneGroups,
    ].filter((group) => {
      if (seenSceneKeys.has(group.key)) return false;
      seenSceneKeys.add(group.key);
      return true;
    }).slice(0, cfg.sceneMemory.maxScenesPerRun);

    for (const { key, members, title, summary } of sceneGroups) {
      const selected = members
        .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
        .slice(0, cfg.sceneMemory.maxSceneMembers);
      const fallbackTitle = selected[0]
        ? (parseSmartMetadata(selected[0].metadata, selected[0]).summary || selected[0].text).slice(0, 80)
        : key;
      const fallbackSummary = summarizeMembers(selected, cfg.sceneMemory.maxSceneMembers);
      const wasClusterRefined = Boolean(title || summary);
      let refined = wasClusterRefined
        ? { title: title || fallbackTitle, summary: summary || fallbackSummary }
        : await refineSceneTitle(deps.llm ?? undefined, selected, {
            title: fallbackTitle,
            summary: fallbackSummary,
          });
      if (refined && !wasClusterRefined) result.llmRefined++;
      if (!refined) {
        refined = { title: fallbackTitle, summary: fallbackSummary };
        result.fallbackUsed++;
      }
      const existing = existingScenes.get(key);
      const now = Date.now();
      const metadata = buildSmartMetadata(existing ?? {
        text: refined.title,
        category: "other",
        importance: 0.8,
        timestamp: now,
      }, {
        memory_kind: "scene",
        memory_category: "patterns",
        memory_type: "knowledge",
        summary: refined.title,
        content: refined.summary,
        scene_id: stableId("scene", key),
        scene_key: key,
        scene_title: refined.title,
        scene_member_ids: selected.map((entry) => entry.id),
        scene_summary_version: Number(parseSmartMetadata(existing?.metadata, existing).scene_summary_version || 0) + 1,
        source: "reflection",
        state: "confirmed",
        memory_layer: "working",
        tier: "working",
        confidence: 0.78,
        utility_score: 0.55,
        last_utility_update_at: now,
      });
      const text = `Scene: ${refined.title}\n${refined.summary}`;
      if (existing) {
        await deps.store.update(existing.id, {
          text,
          vector: await deps.embedder.embedPassage(text),
          importance: Math.max(existing.importance, 0.78),
          category: "other",
          metadata: stringifySmartMetadata(metadata),
        }, scopeFilter);
        result.scenesUpdated++;
      } else {
        await deps.store.store({
          text,
          vector: await deps.embedder.embedPassage(text),
          category: "other",
          scope: selected[0]?.scope || "global",
          importance: 0.78,
          metadata: stringifySmartMetadata(metadata),
        });
        result.scenesCreated++;
      }
    }
  }

  if (cfg.utilityLearning.enabled && deps.store.patchMetadataBatch) {
    const now = Date.now();
    const smoothingPatches = active.flatMap((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const patch = buildUtilitySmoothingPatch(meta, cfg, now);
      return Object.keys(patch).length > 0 ? [{ id: entry.id, patch }] : [];
    });
    if (smoothingPatches.length > 0) {
      result.utilitySmoothed = await deps.store.patchMetadataBatch(smoothingPatches, scopeFilter);
    }
  }

  if (cfg.casePatternDistillation.enabled) {
    let caseGroups = [...groups.entries()]
      .map(([key, members]) => [key, members.filter((entry) => {
        const meta = parseSmartMetadata(entry.metadata, entry);
        return meta.memory_category === "cases" || meta.memory_kind === "case";
      })] as const)
      .filter(([, members]) => members.length >= cfg.casePatternDistillation.minCaseClusterSize)
      .slice(0, cfg.casePatternDistillation.maxPatternsPerRun);
    if (caseGroups.length === 0) {
      const casesByScope = new Map<string, MemoryEntry[]>();
      for (const entry of active) {
        const meta = parseSmartMetadata(entry.metadata, entry);
        if (meta.memory_category !== "cases" && meta.memory_kind !== "case") continue;
        const key = `${entry.scope}:cases:fallback`;
        const list = casesByScope.get(key) ?? [];
        list.push(entry);
        casesByScope.set(key, list);
      }
      caseGroups = [...casesByScope.entries()]
        .filter(([, members]) => members.length >= cfg.casePatternDistillation.minCaseClusterSize)
        .slice(0, cfg.casePatternDistillation.maxPatternsPerRun);
    }

    for (const [key, members] of caseGroups) {
      const existingPattern = active.find((entry) => {
        const meta = parseSmartMetadata(entry.metadata, entry);
        return meta.memory_kind === "pattern" && meta.case_trigger === key;
      });
      if (existingPattern) {
        result.skipped++;
        continue;
      }
      const fallbackTitle = `Pattern: ${key.split(":").slice(-1)[0]}`;
      const fallbackContent = summarizeMembers(members, 8);
      let refined = await refinePattern(deps.llm ?? undefined, members, {
        title: fallbackTitle,
        content: fallbackContent,
        steps: members.slice(0, 3).map((entry) => parseSmartMetadata(entry.metadata, entry).summary || entry.text),
      });
      if (refined) result.llmRefined++;
      if (!refined) {
        refined = {
          title: fallbackTitle,
          content: fallbackContent,
          steps: members.slice(0, 3).map((entry) => parseSmartMetadata(entry.metadata, entry).summary || entry.text),
        };
        result.fallbackUsed++;
      }
      const now = Date.now();
      const sourceIds = members.map((entry) => entry.id);
      const patternText = `${refined.title}\n${refined.content}`;
      const basePatternEntry = {
        text: patternText,
        category: "other" as const,
        importance: 0.82,
        timestamp: now,
      };
      const patternMeta = buildSmartMetadata(basePatternEntry, {
        memory_kind: "pattern",
        memory_category: "patterns",
        memory_type: "knowledge",
        summary: refined.title,
        content: patternText,
        case_trigger: key,
        case_outcome: "distilled_pattern",
        case_steps: refined.steps,
        relations: sourceIds.map((id) => ({ type: "source", targetId: id })).slice(0, 24),
        source: "reflection",
        state: "confirmed",
        memory_layer: "working",
        tier: "working",
        confidence: 0.78,
        utility_score: 0.58,
        last_utility_update_at: now,
      });
      const patternMetadata = stringifySmartMetadata(patternMeta);
      await deps.store.store({
        text: patternText,
        vector: await deps.embedder.embedPassage(patternText),
        category: toStoreCategory("patterns"),
        scope: members[0]?.scope || "global",
        importance: 0.82,
        metadata: patternMetadata,
      });
      result.patternsCreated++;
    }
  }

  deps.logger?.info?.(
    `learning-memory-maintenance: scanned=${result.scanned} scenes=${result.scenesCreated}/${result.scenesUpdated} ` +
      `patterns=${result.patternsCreated} utilitySmoothed=${result.utilitySmoothed} ` +
      `llm=${result.llmRefined} fallback=${result.fallbackUsed}`,
  );
  return result;
}
