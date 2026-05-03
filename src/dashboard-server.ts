import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryStore, StoreIndexStatus } from "./store.js";
import { createRetriever, type MemoryRetriever, type RetrievalDiagnostics } from "./retriever.js";
import { explainMemoryRetrieval } from "./retrieval-explain.js";
import {
  isMemoryActiveAt,
  isMemoryExpired,
  parseSmartMetadata,
  reverseMapLegacyCategory,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { hasActiveRecallSuppression } from "./recall-suppression.js";
import { redactSecrets } from "./session-utils.js";
import { clampInt } from "./utils.js";
import type { FeedbackLoopStatus } from "./feedback-loop.js";

type DashboardStore = Pick<MemoryStore, "stats" | "list" | "hasFtsSupport"> & {
  delete?: MemoryStore["delete"];
  getFtsStatus?: MemoryStore["getFtsStatus"];
  getIndexStatus?: MemoryStore["getIndexStatus"];
};

type DashboardRetriever = Pick<MemoryRetriever, "getConfig"> & {
  retrieveWithTrace?: MemoryRetriever["retrieveWithTrace"];
  getLastDiagnostics?: MemoryRetriever["getLastDiagnostics"];
};

type DashboardScopeManager = {
  getStats?: () => {
    totalScopes: number;
    agentsWithCustomAccess: number;
    scopesByType: Record<string, number>;
  };
  getAllScopes?: () => string[];
  getAccessibleScopes?: (agentId?: string) => string[];
};

export interface MemoryDashboardContext {
  store: DashboardStore;
  retriever: DashboardRetriever;
  scopeManager: DashboardScopeManager;
  embedder?: Embedder;
  feedbackLoop?: { getStatus: () => FeedbackLoopStatus } | null;
}

export interface MemoryDashboardServerOptions {
  host?: string;
  port?: number;
}

export interface RunningMemoryDashboardServer {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

type DashboardFilter = {
  scopeFilter?: string[];
  category?: string;
  quality?: DashboardQualityFilter;
};

type DashboardQualityFilter = "bad_recall" | "suppressed" | "low_confidence" | "inactive";

type DashboardAlert = {
  level: "ok" | "warning" | "danger";
  title: string;
  detail: string;
};

type DashboardMemory = {
  id: string;
  text: string;
  preview: string;
  category: string;
  categoryLabel: string;
  rawCategory: MemoryEntry["category"];
  scope: string;
  scopeLabel: string;
  importance: number;
  timestamp: number;
  ageLabel: string;
  timeLabel: string;
  status: "active" | "archived" | "expired" | "inactive";
  statusLabel: string;
  tier: string;
  tierLabel: string;
  confidence: number;
  accessCount: number;
  source: string;
  sourceLabel: string;
  memoryType: string;
  memoryTypeLabel: string;
  qualityFlags: DashboardQualityFilter[];
  details: {
    l0: string;
    l1: string;
    l2: string;
    factKey?: string;
    validFrom: number;
    invalidatedAt?: number;
  };
  validUntil?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 1314;
const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  profile: "用户画像",
  preferences: "用户偏好",
  entities: "相关实体",
  events: "事件记录",
  cases: "案例经验",
  patterns: "行为模式",
};

const MEMORY_CATEGORY_KEYS = [
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
];

const MEMORY_CATEGORY_TO_STORE_CATEGORY: Record<string, MemoryEntry["category"]> = {
  profile: "fact",
  preferences: "preference",
  entities: "entity",
  events: "decision",
  cases: "fact",
  patterns: "other",
};

const MEMORY_TYPE_LABELS: Record<string, string> = {
  knowledge: "知识记忆",
  experience: "经验记忆",
};

const TIER_LABELS: Record<string, string> = {
  core: "核心记忆",
  working: "工作记忆",
  peripheral: "外围记忆",
  durable: "长期记忆",
  reflection: "反思记忆",
  archive: "归档记忆",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "手动",
  auto: "自动",
  "auto-capture": "自动捕获",
  reflection: "反思",
  "session-summary": "会话摘要",
  legacy: "兼容导入",
};

function normalizeHost(host: string | undefined): string {
  const trimmed = host?.trim();
  return trimmed || DEFAULT_HOST;
}

function normalizePort(port: number | undefined): number {
  if (!Number.isFinite(port)) return DEFAULT_PORT;
  return clampInt(port ?? DEFAULT_PORT, 0, 65_535);
}

function singleParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function numberParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(url.searchParams.get(name));
  return clampInt(Number.isFinite(raw) ? raw : fallback, min, max);
}

function resolveFilter(url: URL): DashboardFilter {
  const scope = singleParam(url, "scope");
  const category = singleParam(url, "category");
  const quality = normalizeQualityFilter(singleParam(url, "quality"));
  return {
    scopeFilter: scope ? [scope] : undefined,
    category,
    quality,
  };
}

function normalizeQualityFilter(value: string | undefined): DashboardQualityFilter | undefined {
  switch (value) {
    case "bad_recall":
    case "suppressed":
    case "low_confidence":
    case "inactive":
      return value;
    default:
      return undefined;
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function ageLabel(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知";
  const diffMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}小时前`;
  return `${Math.floor(diffMs / day)}天前`;
}

function dateTimeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知时间";
  return new Date(timestamp).toLocaleString("zh-CN");
}

function memoryStatus(meta: SmartMemoryMetadata): DashboardMemory["status"] {
  if (meta.state === "archived") return "archived";
  if (isMemoryExpired(meta)) return "expired";
  if (!isMemoryActiveAt(meta)) return "inactive";
  return "active";
}

function statusLabel(status: DashboardMemory["status"]): string {
  switch (status) {
    case "active":
      return "有效";
    case "archived":
      return "已归档";
    case "expired":
      return "已过期";
    case "inactive":
      return "已失效";
  }
}

function displayScope(scope: string): string {
  if (scope === "global") return "全局";
  if (scope.startsWith("other:agent:")) return "other";
  if (scope.startsWith("reflection:agent:")) return scope.slice("reflection:agent:".length) || scope;
  if (scope.startsWith("agent:")) return scope.slice("agent:".length) || scope;
  if (scope.startsWith("project:")) return scope.slice("project:".length) || scope;
  if (scope.startsWith("user:")) return scope.slice("user:".length) || scope;
  if (scope.startsWith("custom:")) return scope.slice("custom:".length) || scope;
  return scope;
}

function displayMemoryText(text: string): string {
  return redactSecrets(text)
    .replace(/\bother:agent:[\w.-]+/g, "other")
    .replace(/\breflection:agent:([\w.-]+)/g, "$1")
    .replace(/\bagent:([\w.-]+)/g, "$1");
}

function displayCategory(category: string): string {
  return MEMORY_CATEGORY_LABELS[category] ?? category;
}

function legacyCategoryPrefilter(category: string | undefined): MemoryEntry["category"] | undefined {
  return category ? MEMORY_CATEGORY_TO_STORE_CATEGORY[category] : undefined;
}

function displayTier(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

function displaySource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function displayMemoryType(type: string): string {
  return MEMORY_TYPE_LABELS[type] ?? type;
}

function qualityFilterLabel(value: DashboardQualityFilter | undefined): string {
  switch (value) {
    case "bad_recall":
      return "差召回";
    case "suppressed":
      return "已抑制";
    case "low_confidence":
      return "低置信";
    case "inactive":
      return "非有效";
    default:
      return "全部质量";
  }
}

type DashboardExplainDetails = Awaited<ReturnType<typeof explainMemoryRetrieval>>["details"];
type DashboardExplainResult = DashboardExplainDetails["results"][number];
type DashboardTraceStage = DashboardExplainDetails["trace"]["stages"][number];
type LegacyStoreCategory = Parameters<typeof reverseMapLegacyCategory>[0];

function legacyStoreCategory(value: unknown): LegacyStoreCategory {
  const raw = typeof value === "string" ? value.split(":")[0] : "";
  switch (raw) {
    case "preference":
    case "fact":
    case "decision":
    case "entity":
    case "other":
    case "reflection":
      return raw;
    default:
      return undefined;
  }
}

function normalizeExplainCategory(result: DashboardExplainResult): string {
  const category = typeof result.category === "string" ? result.category : "";
  if (MEMORY_CATEGORY_LABELS[category]) return category;
  return reverseMapLegacyCategory(
    legacyStoreCategory(result.rawCategory) ?? legacyStoreCategory(category),
    result.text,
  );
}

function dashboardStageLabel(name: string): string {
  switch (name) {
    case "parallel_search":
      return "混合候选";
    case "vector_search":
      return "向量搜索";
    case "bm25_search":
      return "关键词搜索";
    case "rrf_fusion":
      return "结果融合";
    case "min_score_filter":
      return "最低分过滤";
    case "hard_cutoff":
      return "硬阈值过滤";
    case "noise_filter":
      return "噪声过滤";
    case "rerank":
      return "重排";
    case "mmr_diversity":
      return "多样性处理";
    case "length_normalization":
      return "长度归一";
    case "time_decay":
      return "时间衰减";
    case "decay_boost":
      return "衰减增强";
    case "recency_composite":
      return "新近加权";
    case "fallback_scoring":
      return "降级评分";
    default:
      return name;
  }
}

function firstAllDropStage(trace: DashboardExplainDetails["trace"]): DashboardTraceStage | undefined {
  return trace.stages.find((stage) => stage.inputCount > 0 && stage.outputCount === 0);
}

function searchFoundNoCandidates(trace: DashboardExplainDetails["trace"]): boolean {
  const searchStage = trace.stages.find((stage) =>
    stage.name === "parallel_search" ||
    stage.name === "bm25_search" ||
    stage.name === "vector_search"
  );
  return !searchStage || searchStage.outputCount === 0;
}

function buildDashboardExplanation(
  details: DashboardExplainDetails,
  params: {
    scopeFilter?: string[];
    category?: string;
    hasFtsSupport: boolean;
  },
): DashboardExplainDetails["explanation"] {
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const topDropStage = details.explanation.topDropStage;

  if (params.hasFtsSupport === false) {
    reasons.push("当前关键词索引不可用，混合召回会退化，关键词匹配能力可能变弱。");
    suggestions.push("如果关键词召回明显变差，可以运行诊断或重建 FTS 索引。");
  }

  if (details.diagnostics?.degraded) {
    reasons.push(`召回流程发生降级：${details.diagnostics.degradedReason || "原因未知"}。`);
  }

  if (params.scopeFilter && params.scopeFilter.length > 0) {
    reasons.push(`已限定搜索范围：${params.scopeFilter.map(displayScope).join("、")}。`);
  }
  if (params.category) {
    reasons.push(`已限定记忆类型：${displayCategory(params.category)}。`);
  }

  if (details.results.length > 0) {
    if (topDropStage && topDropStage.dropped > 0) {
      reasons.push(
        `候选减少最多的阶段是${dashboardStageLabel(topDropStage.name)}：${topDropStage.inputCount} 条变成 ${topDropStage.outputCount} 条。`,
      );
    }
    return {
      status: details.diagnostics?.degraded ? "degraded" : "matched",
      summary: `命中 ${details.results.length} 条记忆。`,
      reasons,
      suggestions,
      topDropStage,
    };
  }

  const allDropStage = firstAllDropStage(details.trace);
  if (details.diagnostics?.errorMessage) {
    reasons.push(`召回在${dashboardStageLabel(details.diagnostics.failureStage || "unknown")}阶段失败：${details.diagnostics.errorMessage}。`);
    suggestions.push("可以用相同查询再运行 mymem_debug，查看更原始的流水线信息。");
  } else if (allDropStage?.name === "hard_cutoff") {
    reasons.push("所有候选都被硬阈值过滤掉了。");
    suggestions.push("可以降低 retrieval.hardMinScore，或换一个更具体的查询。");
  } else if (allDropStage?.name === "min_score_filter") {
    reasons.push("候选在最低分过滤阶段全部被移除。");
    suggestions.push("可以降低 retrieval.minScore，或放宽查询词。");
  } else if (allDropStage?.name === "noise_filter") {
    reasons.push("噪声过滤移除了所有剩余候选。");
    suggestions.push("可以检查候选文本和 retrieval.filterNoise 设置。");
  } else if (allDropStage?.name === "rerank") {
    reasons.push("重排阶段移除了所有候选。");
    suggestions.push("可以检查重排配置，或临时关闭重排做对比。");
  } else if (searchFoundNoCandidates(details.trace)) {
    reasons.push("向量/关键词搜索没有找到初始候选。");
    suggestions.push("可以检查范围、类型筛选是否过窄，以及记忆库里是否确实存在相关内容。");
  } else if (allDropStage) {
    reasons.push(`所有候选都在${dashboardStageLabel(allDropStage.name)}阶段被移除。`);
  } else {
    reasons.push("没有记忆通过召回流程。");
  }

  if (topDropStage && topDropStage.dropped > 0 && !reasons.some((reason) => reason.includes(dashboardStageLabel(topDropStage.name)))) {
    reasons.push(
      `候选减少最多的阶段是${dashboardStageLabel(topDropStage.name)}：${topDropStage.inputCount} 条变成 ${topDropStage.outputCount} 条。`,
    );
  }

  return {
    status: details.diagnostics?.degraded ? "degraded" : "empty",
    summary: "没有记忆通过召回流程。",
    reasons,
    suggestions,
    topDropStage,
  };
}

function serializeMemory(entry: MemoryEntry): DashboardMemory {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const safeText = displayMemoryText(entry.text);
  const status = memoryStatus(meta);
  const tier = String(meta.memory_tier || meta.tier || meta.memory_layer || "working");
  const source = String(meta.source || "unknown");
  const memoryType = String(meta.memory_type || "knowledge");
  const qualityFlags: DashboardQualityFilter[] = [];
  if (Number(meta.bad_recall_count || 0) > 0) qualityFlags.push("bad_recall");
  if (hasActiveRecallSuppression(meta)) qualityFlags.push("suppressed");
  if (typeof meta.confidence === "number" && meta.confidence < 0.4) qualityFlags.push("low_confidence");
  if (status !== "active") qualityFlags.push("inactive");
  return {
    id: entry.id,
    text: safeText,
    preview: truncateText(safeText, 180),
    category: String(meta.memory_category),
    categoryLabel: displayCategory(String(meta.memory_category)),
    rawCategory: entry.category,
    scope: entry.scope,
    scopeLabel: displayScope(entry.scope),
    importance: entry.importance,
    timestamp: entry.timestamp,
    ageLabel: ageLabel(entry.timestamp),
    timeLabel: dateTimeLabel(entry.timestamp),
    status,
    statusLabel: statusLabel(status),
    tier,
    tierLabel: displayTier(tier),
    confidence: meta.confidence,
    accessCount: meta.access_count,
    source,
    sourceLabel: displaySource(source),
    memoryType,
    memoryTypeLabel: displayMemoryType(memoryType),
    qualityFlags,
    details: {
      l0: displayMemoryText(meta.l0_abstract),
      l1: displayMemoryText(meta.l1_overview),
      l2: displayMemoryText(meta.l2_content),
      ...(meta.fact_key ? { factKey: meta.fact_key } : {}),
      validFrom: meta.valid_from,
      ...(meta.invalidated_at ? { invalidatedAt: meta.invalidated_at } : {}),
    },
    ...(meta.valid_until ? { validUntil: meta.valid_until } : {}),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function relabelCounts(
  counts: Record<string, number>,
  labeler: (value: string) => string,
): Record<string, number> {
  const labeled: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    const label = labeler(key);
    labeled[label] = (labeled[label] || 0) + count;
  }
  return labeled;
}

function collectScopes(
  context: MemoryDashboardContext,
  statsScopeCounts: Record<string, number>,
): string[] {
  const scopes = [
    ...Object.keys(statsScopeCounts),
    ...(context.scopeManager.getAllScopes?.() ?? []),
    ...(context.scopeManager.getAccessibleScopes?.() ?? []),
  ];
  return uniqueSorted(scopes);
}

function labeledMemoryCategoryCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const labeled: Record<string, number> = {};
  const sourceCounts = counts ?? {};
  for (const category of MEMORY_CATEGORY_KEYS) {
    labeled[displayCategory(category)] = Number(sourceCounts[category] || 0);
  }
  for (const [category, count] of Object.entries(sourceCounts)) {
    if (MEMORY_CATEGORY_KEYS.includes(category)) continue;
    labeled[displayCategory(category)] = (labeled[displayCategory(category)] || 0) + count;
  }
  return labeled;
}

function buildAlerts(params: {
  totalCount: number;
  healthSignals: { badRecall: number; suppressed: number; lowConfidence: number };
  hasFtsSupport: boolean;
  retrievalMode?: string;
  ftsStatus: ReturnType<MemoryStore["getFtsStatus"]> | null;
  indexStatus: StoreIndexStatus | null;
}): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  if (params.totalCount === 0) {
    alerts.push({
      level: "warning",
      title: "当前没有可见记忆",
      detail: "记忆库可以访问，但当前筛选条件下没有可展示的记忆。",
    });
  }

  if (params.retrievalMode === "hybrid" && !params.hasFtsSupport) {
    alerts.push({
      level: "warning",
      title: "关键词索引不可用",
      detail: "混合召回仍可运行，但关键词匹配可能变弱，建议重建 FTS 索引。",
    });
  }

  if (params.ftsStatus?.lastError) {
    alerts.push({
      level: "danger",
      title: "FTS 索引报告错误",
      detail: params.ftsStatus.lastError,
    });
  }

  if (params.indexStatus?.vectorIndexPending) {
    alerts.push({
      level: "warning",
      title: "向量索引尚未就绪",
      detail: "当前表可能仍在使用穷举向量搜索，或向量索引尚未创建。",
    });
  }

  if ((params.indexStatus?.missingRecommendedScalars.length ?? 0) > 0) {
    alerts.push({
      level: "warning",
      title: "缺少推荐的标量索引",
      detail: params.indexStatus?.missingRecommendedScalars.join(", ") ?? "",
    });
  }

  if (params.healthSignals.badRecall > 0 || params.healthSignals.suppressed > 0 || params.healthSignals.lowConfidence > 0) {
    alerts.push({
      level: "warning",
      title: "记忆质量信号需要关注",
      detail: `疑似差召回 ${params.healthSignals.badRecall} 条，已抑制 ${params.healthSignals.suppressed} 条，低置信 ${params.healthSignals.lowConfidence} 条。`,
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      level: "ok",
      title: "记忆库状态正常",
      detail: "当前筛选条件下没有发现需要处理的仪表盘级别告警。",
    });
  }

  return alerts;
}

async function optionalIndexStatus(store: DashboardStore): Promise<StoreIndexStatus | null> {
  if (typeof store.getIndexStatus !== "function") return null;
  try {
    return await store.getIndexStatus();
  } catch {
    return null;
  }
}

function optionalFtsStatus(store: DashboardStore): ReturnType<MemoryStore["getFtsStatus"]> | null {
  if (typeof store.getFtsStatus !== "function") return null;
  try {
    return store.getFtsStatus();
  } catch {
    return null;
  }
}

function publicRetrievalConfig(config: ReturnType<MemoryRetriever["getConfig"]>) {
  return {
    mode: config.mode,
    vectorWeight: config.vectorWeight,
    bm25Weight: config.bm25Weight,
    queryExpansion: config.queryExpansion,
    minScore: config.minScore,
    hardMinScore: config.hardMinScore,
    rerank: config.rerank,
    candidatePoolSize: config.candidatePoolSize,
    recencyHalfLifeDays: config.recencyHalfLifeDays,
    recencyWeight: config.recencyWeight,
    filterNoise: config.filterNoise,
    timeDecayHalfLifeDays: config.timeDecayHalfLifeDays,
    tagPrefixes: config.tagPrefixes,
  };
}

async function buildDashboardSummary(
  context: MemoryDashboardContext,
  filter: DashboardFilter,
) {
  const retrievalConfig = context.retriever.getConfig();
  const [stats, indexStatus] = await Promise.all([
    context.store.stats(filter.scopeFilter),
    optionalIndexStatus(context.store),
  ]);
  const ftsStatus = optionalFtsStatus(context.store);
  const availableScopes = collectScopes(context, stats.scopeCounts);
  const rawScopeStats = context.scopeManager.getStats?.() ?? {
    totalScopes: availableScopes.length,
    agentsWithCustomAccess: 0,
    scopesByType: {},
  };
  const scopeStats = {
    ...rawScopeStats,
    totalScopes: Math.max(rawScopeStats.totalScopes, availableScopes.length),
  };

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      scope: filter.scopeFilter?.[0] ?? null,
      category: filter.category ?? null,
      quality: filter.quality ?? null,
    },
    memory: stats,
    display: {
      categoryCounts: labeledMemoryCategoryCounts(stats.memoryCategoryCounts),
      tierDistribution: relabelCounts(stats.tierDistribution, displayTier),
      recentActivity: {
        "1 天内": stats.recentActivity.last24h,
        "7 天内": stats.recentActivity.last7d,
        "1 月内": stats.recentActivity.last30d ?? stats.recentActivity.last7d,
        "全部": stats.totalCount,
      },
    },
    scopes: {
      ...scopeStats,
      available: availableScopes,
      labels: Object.fromEntries(availableScopes.map((scope) => [scope, displayScope(scope)])),
    },
    retrieval: {
      ...publicRetrievalConfig(retrievalConfig),
      hasFtsSupport: context.store.hasFtsSupport,
      ftsStatus,
      indexStatus,
    },
    feedbackLoop: context.feedbackLoop?.getStatus() ?? null,
    alerts: buildAlerts({
      totalCount: stats.totalCount,
      healthSignals: stats.healthSignals,
      hasFtsSupport: context.store.hasFtsSupport,
      retrievalMode: retrievalConfig.mode,
      ftsStatus,
      indexStatus,
    }),
  };
}

async function buildMemoryList(
  context: MemoryDashboardContext,
  filter: DashboardFilter,
  limit: number,
  offset: number,
) {
  const rows = await loadDashboardMemories(context, filter, limit, offset);
  return {
    filters: {
      scope: filter.scopeFilter?.[0] ?? null,
      category: filter.category ?? null,
      quality: filter.quality ?? null,
      qualityLabel: qualityFilterLabel(filter.quality),
      limit,
      offset,
    },
    count: rows.length,
    memories: rows,
  };
}

async function loadDashboardMemories(
  context: MemoryDashboardContext,
  filter: DashboardFilter,
  limit: number,
  offset: number,
): Promise<DashboardMemory[]> {
  const target = clampInt(limit, 1, 2_000);
  const safeOffset = Math.max(0, Math.trunc(offset));
  const pageSize = 200;
  const collected: DashboardMemory[] = [];
  let rawOffset = 0;
  let scanned = 0;
  const maxScanned = Math.min(10_000, (safeOffset + target) * 8 + 400);
  const storeCategory = legacyCategoryPrefilter(filter.category);

  while (collected.length < safeOffset + target && scanned < maxScanned) {
    const page = await context.store.list(filter.scopeFilter, storeCategory, pageSize, rawOffset);
    if (page.length === 0) break;
    rawOffset += page.length;
    scanned += page.length;
    for (const entry of page) {
      const serialized = serializeMemory(entry);
      if (filter.category && serialized.category !== filter.category) continue;
      if (filter.quality && !serialized.qualityFlags.includes(filter.quality)) continue;
      collected.push(serialized);
    }
    if (page.length < pageSize) break;
  }

  return collected.slice(safeOffset, safeOffset + target);
}

function resolveExplainRetriever(context: MemoryDashboardContext): Pick<
  MemoryRetriever,
  "retrieveWithTrace" | "getConfig" | "getLastDiagnostics"
> {
  if (typeof context.retriever.retrieveWithTrace === "function") {
    return {
      retrieveWithTrace: context.retriever.retrieveWithTrace.bind(context.retriever),
      getConfig: context.retriever.getConfig.bind(context.retriever),
      getLastDiagnostics: typeof context.retriever.getLastDiagnostics === "function"
        ? context.retriever.getLastDiagnostics.bind(context.retriever)
        : (() => null as RetrievalDiagnostics | null),
    };
  }

  if (context.embedder) {
    return createRetriever(
      context.store as MemoryStore,
      context.embedder,
      context.retriever.getConfig(),
    );
  }

  throw new Error("仪表盘诊断需要 embedder，或需要支持 retrieveWithTrace() 的 retriever。");
}

async function buildExplainReport(context: MemoryDashboardContext, url: URL) {
  const query = singleParam(url, "query");
  if (!query) {
    return {
      statusCode: 400,
      payload: {
        error: "query_required",
        message: "请输入要诊断的查询内容。",
      },
    };
  }

  const filter = resolveFilter(url);
  const limit = numberParam(url, "limit", 5, 1, 20);
  await context.store.stats(filter.scopeFilter);
  const retriever = resolveExplainRetriever(context);
  const report = await explainMemoryRetrieval(retriever, {
    query,
    limit,
    scopeFilter: filter.scopeFilter,
    category: filter.category,
    source: "cli",
    hasFtsSupport: context.store.hasFtsSupport,
  });
  report.details.results = report.details.results.map((result) => {
    const category = normalizeExplainCategory(result);
    return {
      ...result,
      category,
      categoryLabel: displayCategory(category),
      scopeLabel: displayScope(result.scope),
    };
  });
  report.details.explanation = buildDashboardExplanation(report.details, {
    scopeFilter: filter.scopeFilter,
    category: filter.category,
    hasFtsSupport: context.store.hasFtsSupport,
  });
  return {
    statusCode: 200,
    payload: report.details,
  };
}

async function routeDashboardRequest(
  context: MemoryDashboardContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  try {
    if (req.method === "DELETE" && url.pathname.startsWith("/api/memories/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/memories/".length));
      const filter = resolveFilter(url);
      if (!id.trim()) {
        sendJson(res, 400, { error: "memory_id_required", message: "缺少记忆 ID。" });
        return;
      }
      if (typeof context.store.delete !== "function") {
        sendJson(res, 501, { error: "delete_unavailable", message: "当前记忆库不支持从仪表盘删除。" });
        return;
      }
      const deleted = await context.store.delete(id, filter.scopeFilter);
      sendJson(res, deleted ? 200 : 404, {
        ok: deleted,
        id,
        ...(deleted ? {} : { error: "memory_not_found", message: "未找到这条记忆，或当前 scope 无权删除。" }),
      });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed", message: "这个接口不支持当前请求方式。" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/memories") {
      sendHtml(res, DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "public, max-age=86400" });
      res.end();
      return;
    }

    if (url.pathname === "/api/summary") {
      sendJson(res, 200, await buildDashboardSummary(context, resolveFilter(url)));
      return;
    }

    if (url.pathname === "/api/memories") {
      const limit = numberParam(url, "limit", 50, 1, 200);
      const offset = numberParam(url, "offset", 0, 0, 1_000_000);
      sendJson(res, 200, await buildMemoryList(context, resolveFilter(url), limit, offset));
      return;
    }

    if (url.pathname === "/api/explain") {
      const result = await buildExplainReport(context, url);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    sendJson(res, 404, { error: "not_found", message: "没有找到这个仪表盘接口。" });
  } catch (error) {
    sendJson(res, 500, {
      error: "dashboard_failed",
      message: toErrorMessage(error),
    });
  }
}

export async function startMemoryDashboardServer(
  context: MemoryDashboardContext,
  options: MemoryDashboardServerOptions = {},
): Promise<RunningMemoryDashboardServer> {
  const host = normalizeHost(options.host);
  const port = normalizePort(options.port);
  const server = createServer((req, res) => {
    void routeDashboardRequest(context, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MyMem 记忆管理台</title>
  <style>
    :root {
      --bg: #f6f7fb;
      --panel: #ffffff;
      --panel-soft: #f9fafb;
      --text: #172033;
      --muted: #667085;
      --line: #d9dee8;
      --teal: #147d82;
      --teal-soft: #d8f1ef;
      --violet: #6d5dfc;
      --amber: #b86e00;
      --amber-soft: #fff3d6;
      --green: #16833a;
      --green-soft: #ddf7e6;
      --red: #c2413a;
      --red-soft: #fee4e2;
      --shadow: 0 10px 30px rgba(23, 32, 51, 0.08);
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    button, input, select {
      font: inherit;
      letter-spacing: 0;
    }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 8px;
      height: 38px;
      padding: 0 12px;
      cursor: pointer;
    }
    button.primary {
      background: var(--teal);
      border-color: var(--teal);
      color: #ffffff;
    }
    button.icon {
      width: 38px;
      padding: 0;
      display: inline-grid;
      place-items: center;
    }
    input, select {
      height: 38px;
      border: 1px solid var(--line);
      background: #ffffff;
      border-radius: 8px;
      color: var(--text);
      padding: 0 10px;
      min-width: 0;
    }
    input:focus, select:focus, button:focus {
      outline: 2px solid rgba(20, 125, 130, 0.25);
      outline-offset: 2px;
    }
    .app {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--line);
      background: rgba(246, 247, 251, 0.92);
      backdrop-filter: blur(14px);
    }
    .topbar-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 14px 20px;
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 16px;
      align-items: center;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand-mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #172033;
      color: #ffffff;
      font-weight: 800;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
    }
    .subtle {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .nav-link {
      height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      color: var(--text);
      text-decoration: none;
      background: var(--panel);
      font-size: 13px;
    }
    .nav-link.active {
      color: #ffffff;
      background: var(--text);
      border-color: var(--text);
    }
    .layout {
      width: 100%;
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 20px 28px;
      display: grid;
      gap: 16px;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(5, minmax(140px, 1fr));
      gap: 12px;
    }
    .metric {
      min-height: 104px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 780;
      line-height: 1;
      margin-top: 12px;
    }
    .metric-foot {
      color: var(--muted);
      font-size: 12px;
      margin-top: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
      gap: 16px;
      align-items: start;
    }
    .column {
      display: grid;
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-head {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-title {
      margin: 0;
      font-size: 15px;
      line-height: 1.2;
    }
    .panel-body {
      padding: 14px 16px 16px;
    }
    .charts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
      align-items: start;
    }
    .chart-card {
      min-width: 0;
    }
    .chart-card.wide {
      grid-column: 1 / -1;
    }
    .category-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 18px;
      row-gap: 4px;
    }
    .category-column {
      display: grid;
      align-content: start;
      gap: 10px;
      min-width: 0;
    }
    .chart-title {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "label count"
        "track track";
      gap: 6px 12px;
      align-items: end;
      min-height: 44px;
      font-size: 13px;
    }
    .bar-label {
      grid-area: label;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .bar-track {
      height: 10px;
      background: #edf1f6;
      border-radius: 999px;
      overflow: hidden;
      grid-area: track;
      min-width: 0;
    }
    .bar-fill {
      height: 100%;
      width: 0;
      border-radius: 999px;
      background: var(--teal);
    }
    .bar-fill.alt { background: var(--violet); }
    .bar-fill.third { background: var(--amber); }
    .bar-count {
      grid-area: count;
      text-align: right;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      min-width: max-content;
    }
    .memory-list {
      display: grid;
      gap: 10px;
    }
    .memories-page {
      display: none;
    }
    body[data-view="memories"] .memories-page {
      display: block;
    }
    body[data-view="memories"] [data-view-section="dashboard"] {
      display: none;
    }
    body[data-view="dashboard"] [data-view-section="memories"] {
      display: none;
    }
    body[data-view="dashboard"] .memory-filter {
      display: none;
    }
    .masonry-list {
      column-count: 3;
      column-gap: 12px;
    }
    .masonry-list .memory-item {
      display: inline-block;
      width: 100%;
      margin: 0 0 12px;
      break-inside: avoid;
    }
    .memories-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 14px;
    }
    .memory-head-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .memory-head-actions .memory-filter {
      min-width: 112px;
      max-width: 140px;
    }
    .memory-head-actions .quality-filter {
      min-width: 126px;
    }
    .memory-item {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel-soft);
      min-width: 0;
    }
    .memory-item[data-id] {
      padding-right: 64px;
      cursor: pointer;
    }
    .memory-actions {
      position: absolute;
      top: 10px;
      right: 10px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }
    .memory-actions button {
      height: 30px;
      padding: 0 9px;
      font-size: 12px;
    }
    .memory-actions .danger {
      border-color: #f4b3ae;
      color: var(--red);
      background: #fff8f7;
    }
    .memory-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #edf1f6;
      color: #344054;
      font-size: 12px;
      white-space: nowrap;
    }
    .chip.teal { background: var(--teal-soft); color: #09575b; }
    .chip.green { background: var(--green-soft); color: var(--green); }
    .chip.amber { background: var(--amber-soft); color: var(--amber); }
    .chip.red { background: var(--red-soft); color: var(--red); }
    .chip.quality {
      background: #eef0ff;
      color: #5547b8;
    }
    .memory-text {
      font-size: 14px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .memory-stats {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .explain-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 92px 110px;
      gap: 8px;
      align-items: center;
    }
    .explain-output {
      margin-top: 14px;
      display: grid;
      gap: 12px;
    }
    .diagnosis {
      border-left: 4px solid var(--teal);
      background: #f3fbfa;
      padding: 12px;
      border-radius: 8px;
    }
    .diagnosis.empty { border-left-color: var(--amber); background: #fffaf0; }
    .diagnosis.degraded { border-left-color: var(--red); background: #fff6f5; }
    .diagnosis-title {
      font-weight: 720;
      margin-bottom: 6px;
    }
    .plain-list {
      margin: 8px 0 0;
      padding-left: 18px;
      color: var(--muted);
      line-height: 1.45;
    }
    .stage-list {
      display: grid;
      gap: 8px;
    }
    .stage-toggle {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      padding: 0;
      overflow: hidden;
    }
    .stage-toggle summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 42px;
      padding: 0 12px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .stage-toggle summary::-webkit-details-marker {
      display: none;
    }
    .stage-toggle summary::after {
      content: "展开";
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .stage-toggle[open] summary {
      border-bottom: 1px solid var(--line);
    }
    .stage-toggle[open] summary::after {
      content: "收起";
    }
    .stage-toggle .stage-list {
      padding: 12px;
    }
    .stage {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) 92px 70px;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      border-bottom: 1px solid #edf1f6;
      padding-bottom: 8px;
    }
    .stage:last-child { border-bottom: 0; padding-bottom: 0; }
    .stage-flow {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .stage-time {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .alert {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel-soft);
    }
    .alert.ok { border-color: #bde8ca; background: var(--green-soft); }
    .alert.warning { border-color: #f6cf85; background: var(--amber-soft); }
    .alert.danger { border-color: #f4b3ae; background: var(--red-soft); }
    .alert-title {
      font-weight: 720;
      margin-bottom: 4px;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .feedback-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .config-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: var(--panel-soft);
      min-width: 0;
    }
    .config-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .config-value {
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .detail-overlay {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: none;
      background: rgba(23, 32, 51, 0.46);
      padding: 20px;
      overflow: auto;
    }
    .detail-overlay.open {
      display: grid;
      place-items: center;
    }
    .detail-panel {
      width: min(860px, 100%);
      max-height: min(760px, calc(100vh - 40px));
      overflow: auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 24px 80px rgba(23, 32, 51, 0.22);
    }
    .detail-head {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .detail-title {
      font-size: 15px;
      font-weight: 760;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .detail-body {
      padding: 16px;
      display: grid;
      gap: 14px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .detail-section {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel-soft);
    }
    .detail-section h3 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .detail-text {
      white-space: pre-wrap;
      line-height: 1.55;
      font-size: 14px;
      overflow-wrap: anywhere;
      margin: 0;
    }
    .empty-state {
      color: var(--muted);
      font-size: 14px;
      padding: 18px 0;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid #b8c3cf;
      border-top-color: var(--teal);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 1080px) {
      .kpis { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .topbar-inner {
        grid-template-columns: 1fr;
        padding: 12px;
      }
      .toolbar {
        justify-content: stretch;
      }
      .toolbar button {
        flex: 1 1 130px;
      }
      .memory-head-actions {
        width: 100%;
        justify-content: stretch;
      }
      .memory-head-actions .memory-filter {
        flex: 1 1 130px;
        max-width: none;
      }
      .memory-head-actions #memoryCount {
        flex: 1 1 100%;
      }
      .layout { padding: 12px; }
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .charts { grid-template-columns: 1fr; }
      .chart-card.wide { grid-column: auto; }
      .category-grid { grid-template-columns: 1fr; }
      .explain-form { grid-template-columns: 1fr; }
      .masonry-list { column-count: 2; }
      .memory-stats { grid-template-columns: 1fr; }
      .config-grid { grid-template-columns: 1fr; }
      .feedback-grid { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      .stage { grid-template-columns: 1fr 70px 70px; }
    }
    @media (max-width: 440px) {
      .kpis { grid-template-columns: 1fr; }
      .metric { min-height: 92px; }
      .masonry-list { column-count: 1; }
    }
  </style>
</head>
<body data-view="dashboard">
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-mark">M</div>
          <div>
            <h1>MyMem 记忆管理台</h1>
            <div class="subtle" id="lastUpdated">正在读取本地记忆库</div>
          </div>
        </div>
        <div class="toolbar">
          <a class="nav-link" id="overviewLink" href="/">总览</a>
          <a class="nav-link" id="memoriesLink" href="/memories">记忆管理</a>
          <button class="icon" id="refreshBtn" title="刷新" aria-label="刷新">↻</button>
        </div>
      </div>
    </header>

    <main class="layout">
      <section class="kpis" aria-label="总览" data-view-section="dashboard">
        <div class="metric">
          <div class="metric-label">可见记忆</div>
          <div class="metric-value" id="kpiTotal">--</div>
          <div class="metric-foot" id="kpiRecent">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">记忆范围</div>
          <div class="metric-value" id="kpiScopes">--</div>
          <div class="metric-foot" id="kpiAgents">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">召回模式</div>
          <div class="metric-value" id="kpiMode">--</div>
          <div class="metric-foot" id="kpiFts">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">质量信号</div>
          <div class="metric-value" id="kpiQuality">--</div>
          <div class="metric-foot">差召回 / 已抑制 / 低置信</div>
        </div>
        <div class="metric">
          <div class="metric-label">候选池</div>
          <div class="metric-value" id="kpiPool">--</div>
          <div class="metric-foot" id="kpiThresholds">--</div>
        </div>
      </section>

      <section class="grid" data-view-section="dashboard">
        <div class="column">
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">分布概览</h2>
              <span class="subtle" id="distributionHint">--</span>
            </div>
            <div class="panel-body">
              <div class="charts">
                <div class="chart-card wide">
                  <div class="chart-title">按记忆类型</div>
                  <div id="categoryChart"></div>
                </div>
                <div class="chart-card">
                  <div class="chart-title">按活跃时间</div>
                  <div id="activityChart"></div>
                </div>
                <div class="chart-card">
                  <div class="chart-title">按层级</div>
                  <div id="tierChart"></div>
                </div>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">反馈循环</h2>
              <span class="subtle" id="feedbackHint">--</span>
            </div>
            <div class="panel-body" id="feedbackLoopPanel">
              <div class="empty-state">正在读取反馈循环状态...</div>
            </div>
          </section>
        </div>

        <aside class="column">
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">召回诊断</h2>
              <span class="subtle" id="explainCount">尚未查询</span>
            </div>
            <div class="panel-body">
              <div class="explain-form">
                <input id="queryInput" placeholder="输入想查的记忆" aria-label="查询内容">
                <select id="limitInput" aria-label="返回数量">
                  <option value="3">前 3 条</option>
                  <option value="5" selected>前 5 条</option>
                  <option value="10">前 10 条</option>
                </select>
                <button class="primary" id="explainBtn">诊断</button>
              </div>
              <div class="explain-output" id="explainOutput">
                <div class="empty-state">暂无召回诊断。</div>
              </div>
            </div>
          </section>
        </aside>
      </section>
      <section class="memories-page" data-view-section="memories">
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">记忆瀑布流</h2>
            <div class="memory-head-actions">
              <select class="memory-filter" id="scopeFilter" aria-label="记忆范围"></select>
              <select class="memory-filter" id="categoryFilter" aria-label="记忆类型">
                <option value="">全部类型</option>
                <option value="profile">用户画像</option>
                <option value="preferences">用户偏好</option>
                <option value="entities">相关实体</option>
                <option value="events">事件记录</option>
                <option value="cases">案例经验</option>
                <option value="patterns">行为模式</option>
              </select>
              <select class="memory-filter quality-filter" id="qualityFilter" aria-label="质量筛选">
                <option value="">全部质量</option>
                <option value="bad_recall">差召回</option>
                <option value="suppressed">已抑制</option>
                <option value="low_confidence">低置信</option>
                <option value="inactive">非有效</option>
              </select>
              <span class="subtle" id="memoryCount">--</span>
            </div>
          </div>
          <div class="panel-body">
            <div class="masonry-list" id="masonryMemories"></div>
            <div class="memories-controls">
              <span class="subtle" id="memoryLoadHint">按当前筛选加载</span>
              <button id="loadMoreBtn">加载更多</button>
            </div>
          </div>
        </section>
      </section>
    </main>
    <div class="detail-overlay" id="detailOverlay" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
      <div class="detail-panel">
        <div class="detail-head">
          <h2 class="detail-title" id="detailTitle">记忆详情</h2>
          <button class="icon" id="detailCloseBtn" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="detail-body" id="detailBody"></div>
      </div>
    </div>
  </div>

  <script>
    const CATEGORY_ORDER = ["用户画像", "用户偏好", "相关实体", "事件记录", "案例经验", "行为模式"];

    const state = {
      summary: null,
      busy: false,
      memoriesBusy: false,
      memoryLimit: 36,
      memoryOffset: 0,
      hasMoreMemories: true,
      memoriesById: new Map()
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function pct(value) {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n * 100) + "%" : "--";
    }

    function fixed(value, digits) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(digits) : "--";
    }

    function countValue(value) {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : "0";
    }

    function retrievalModeLabel(mode) {
      return ({
        hybrid: "混合检索",
        vector: "向量",
        bm25: "关键词",
        keyword: "关键词",
        fallback: "降级"
      })[mode] || mode || "未知";
    }

    function rerankLabel(value) {
      return ({
        none: "关闭重排",
        "cross-encoder": "交叉重排",
        lightweight: "轻量重排",
        llm: "大模重排",
        heuristic: "规则重排"
      })[value] || value || "未知";
    }

    function qualityLabel(value) {
      return ({
        bad_recall: "差召回",
        suppressed: "已抑制",
        low_confidence: "低置信",
        inactive: "非有效"
      })[value] || "全部质量";
    }

    function currentFilters() {
      const scope = $("scopeFilter").value;
      const category = $("categoryFilter").value;
      const quality = $("qualityFilter").value;
      return {
        scope,
        category,
        quality
      };
    }

    function queryString(params) {
      const sp = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") sp.set(key, value);
      });
      const text = sp.toString();
      return text ? "?" + text : "";
    }

    async function fetchJson(path, options) {
      const response = await fetch(path, { cache: "no-store", ...(options || {}) });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "request failed");
      }
      return payload;
    }

    function renderScopeOptions(scopes, selected) {
      const select = $("scopeFilter");
      const previous = selected || select.value;
      const labels = (state.summary && state.summary.scopes && state.summary.scopes.labels) || {};
      const options = ['<option value="">全部范围</option>'].concat(
        (scopes || []).map((scope) => '<option value="' + escapeHtml(scope) + '">' + escapeHtml(labels[scope] || scope) + '</option>')
      );
      select.innerHTML = options.join("");
      select.value = previous;
    }

    function renderKpis(summary) {
      const memory = summary.memory;
      const retrieval = summary.retrieval;
      const quality = memory.healthSignals || {};
      $("kpiTotal").textContent = memory.totalCount;
      $("kpiRecent").textContent = "1 天内 " + memory.recentActivity.last24h + "，7 天内 " + memory.recentActivity.last7d;
      $("kpiScopes").textContent = summary.scopes.totalScopes;
      $("kpiAgents").textContent = summary.scopes.agentsWithCustomAccess + " 个自定义权限主体";
      $("kpiMode").textContent = retrievalModeLabel(retrieval.mode);
      $("kpiFts").textContent = retrieval.hasFtsSupport ? "关键词索引可用" : "关键词索引不可用";
      $("kpiQuality").textContent = [quality.badRecall || 0, quality.suppressed || 0, quality.lowConfidence || 0].join(" / ");
      $("kpiPool").textContent = retrieval.candidatePoolSize;
      $("kpiThresholds").textContent = "最低 " + fixed(retrieval.minScore, 2) + "，硬阈值 " + fixed(retrieval.hardMinScore, 2);
      $("distributionHint").textContent = memory.totalCount + " 条可见";
    }

    function renderBars(targetId, data, className, options) {
      const target = $(targetId);
      const entries = Object.entries(data || {});
      if (!(options && options.preserveOrder)) {
        entries.sort((a, b) => b[1] - a[1]);
      }
      if (entries.length === 0) {
        target.innerHTML = '<div class="empty-state">暂无数据</div>';
        return;
      }
      const max = Math.max(1, ...entries.map(([, count]) => Number(count) || 0));
      target.innerHTML = entries.map(([label, count]) => {
        const width = Math.max(3, Math.round(((Number(count) || 0) / max) * 100));
        return '<div class="bar-row">' +
          '<div class="bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
          '<div class="bar-track"><div class="bar-fill ' + className + '" style="width:' + width + '%"></div></div>' +
          '<div class="bar-count">' + escapeHtml(count) + '</div>' +
          '</div>';
      }).join("");
    }

    function renderCategoryBars(targetId, data) {
      const target = $(targetId);
      const source = data || {};
      const knownEntries = CATEGORY_ORDER.map((label) => [label, Number(source[label]) || 0]);
      const extraEntries = Object.entries(source)
        .filter(([label]) => !CATEGORY_ORDER.includes(label))
        .sort((a, b) => Number(b[1]) - Number(a[1]));
      const entries = knownEntries.concat(extraEntries);
      if (entries.length === 0) {
        target.innerHTML = '<div class="empty-state">暂无数据</div>';
        return;
      }
      const max = Math.max(1, ...entries.map(([, count]) => Number(count) || 0));
      const renderRows = (rows) => rows.map(([label, count]) => {
        const width = Math.max(3, Math.round(((Number(count) || 0) / max) * 100));
        return '<div class="bar-row">' +
          '<div class="bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
          '<div class="bar-track"><div class="bar-fill alt" style="width:' + width + '%"></div></div>' +
          '<div class="bar-count">' + escapeHtml(count) + '</div>' +
          '</div>';
      }).join("");
      target.innerHTML =
        '<div class="category-grid">' +
          '<div class="category-column">' + renderRows(entries.slice(0, 3)) + '</div>' +
          '<div class="category-column">' + renderRows(entries.slice(3)) + '</div>' +
        '</div>';
    }

    function renderCharts(summary) {
      renderCategoryBars("categoryChart", summary.display.categoryCounts);
      renderBars("tierChart", summary.display.tierDistribution, "third");
      renderBars("activityChart", {
        "1 天内": summary.display.recentActivity["1 天内"],
        "7 天内": summary.display.recentActivity["7 天内"],
        "1 月内": summary.display.recentActivity["1 月内"],
        "全部": summary.display.recentActivity["全部"]
      }, "", { preserveOrder: true });
    }

    function timeLabel(timestamp) {
      const n = Number(timestamp);
      if (!Number.isFinite(n) || n <= 0) return "尚未运行";
      return new Date(n).toLocaleString("zh-CN");
    }

    function renderFeedbackLoop(summary) {
      const status = summary.feedbackLoop;
      if (!status) {
        $("feedbackHint").textContent = "未启用";
        $("feedbackLoopPanel").innerHTML = '<div class="empty-state">当前运行环境没有反馈循环状态。</div>';
        return;
      }
      const prior = status.priorAdaptation || {};
      const lessons = status.preventiveLessons || {};
      $("feedbackHint").textContent = status.enabled && !status.disposed ? "运行中" : "已停止";
      $("feedbackLoopPanel").innerHTML =
        '<div class="feedback-grid">' +
          '<div class="config-item"><div class="config-label">预防教训</div><div class="config-value">' + countValue(lessons.learned) + '</div><div class="subtle">更新 ' + countValue(lessons.updated) + '，确认 ' + countValue(lessons.promoted) + '</div></div>' +
          '<div class="config-item"><div class="config-label">待处理证据</div><div class="config-value">' + countValue(lessons.bufferedEvidence) + '</div><div class="subtle">错误 / 修正</div></div>' +
          '<div class="config-item"><div class="config-label">先验自适应</div><div class="config-value">' + countValue(prior.cycles) + '</div><div class="subtle">观测准入 ' + countValue(prior.observedAdmitted) + '</div></div>' +
        '</div>' +
        '<div class="config-grid">' +
          '<div class="config-item"><div class="config-label">最近扫描</div><div class="config-value">' + escapeHtml(timeLabel(lessons.lastScanAt)) + '</div></div>' +
          '<div class="config-item"><div class="config-label">扫描轮次</div><div class="config-value">' + countValue(lessons.scanCycles) + '</div></div>' +
          '<div class="config-item"><div class="config-label">最近自适应</div><div class="config-value">' + escapeHtml(timeLabel(prior.lastAdaptedAt)) + '</div></div>' +
          '<div class="config-item"><div class="config-label">教训跳过</div><div class="config-value">' + countValue(lessons.skipped) + '</div></div>' +
        '</div>';
    }

    function statusChip(status) {
      if (status === "active") return '<span class="chip green">有效</span>';
      if (status === "archived") return '<span class="chip amber">已归档</span>';
      if (status === "expired") return '<span class="chip red">已过期</span>';
      return '<span class="chip amber">已失效</span>';
    }

    function qualityChips(memory) {
      return (memory.qualityFlags || []).map((flag) =>
        '<span class="chip quality">' + escapeHtml(qualityLabel(flag)) + '</span>'
      ).join("");
    }

    function renderMemoryCards(memories) {
      return (memories || []).map((memory) => (
        '<article class="memory-item" data-id="' + escapeHtml(memory.id) + '">' +
          '<div class="memory-meta">' +
            '<span class="chip teal">' + escapeHtml(memory.categoryLabel) + '</span>' +
            '<span class="chip">' + escapeHtml(memory.scopeLabel) + '</span>' +
            statusChip(memory.status) +
            qualityChips(memory) +
            '<span class="chip">' + escapeHtml(memory.ageLabel) + '</span>' +
          '</div>' +
          '<div class="memory-text">' + escapeHtml(memory.preview) + '</div>' +
          '<div class="memory-stats">' +
            '<span>重要性 ' + pct(memory.importance) + '</span>' +
            '<span>置信度 ' + pct(memory.confidence) + '</span>' +
            '<span>访问 ' + escapeHtml(memory.accessCount) + '</span>' +
          '</div>' +
          '<div class="memory-actions">' +
            '<button class="danger" data-action="delete" data-id="' + escapeHtml(memory.id) + '">删除</button>' +
          '</div>' +
        '</article>'
      )).join("");
    }

    function renderMemoryPage(memories, reset) {
      const list = $("masonryMemories");
      if (reset) {
        state.memoriesById = new Map();
        list.innerHTML = "";
      }
      for (const memory of memories || []) {
        state.memoriesById.set(memory.id, memory);
      }
      const shown = state.memoriesById.size;
      $("memoryCount").textContent = shown > 0 ? "已显示 " + shown + " 条" : "暂无记忆";

      if (!memories || memories.length === 0) {
        if (reset) list.innerHTML = '<div class="empty-state">当前筛选下没有记忆。</div>';
      } else if (reset) {
        list.innerHTML = renderMemoryCards(memories);
      } else {
        list.insertAdjacentHTML("beforeend", renderMemoryCards(memories));
      }

      $("loadMoreBtn").disabled = !state.hasMoreMemories || state.memoriesBusy;
      $("memoryLoadHint").textContent = state.hasMoreMemories ? "可以继续加载更多" : "当前筛选已全部加载";
    }

    function stageName(name) {
      return ({
        parallel_search: "混合候选",
        vector_search: "向量搜索",
        bm25_search: "关键词搜索",
        rrf_fusion: "结果融合",
        min_score_filter: "最低分过滤",
        hard_cutoff: "硬阈值过滤",
        rerank: "重排处理",
        noise_filter: "噪声过滤",
        mmr_diversity: "多样性处理",
        length_normalization: "长度归一",
        time_decay: "时间衰减",
        decay_boost: "衰减增强",
        recency_composite: "新近加权",
        fallback_scoring: "降级评分"
      })[name] || name;
    }

    function renderExplain(report) {
      const explanation = report.explanation || {};
      $("explainCount").textContent = report.count + " 条结果";
      const diagnosisClass = explanation.status === "empty" ? " empty" : explanation.status === "degraded" ? " degraded" : "";
      const reasons = (explanation.reasons || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("");
      const suggestions = (explanation.suggestions || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("");
      const traceStages = (report.trace && report.trace.stages) || [];
      const stages = traceStages.map((stage) => {
        const dropped = Math.max(0, Number(stage.inputCount || 0) - Number(stage.outputCount || 0));
        const flow = Number(stage.inputCount || 0) === 0
          ? "找到 " + stage.outputCount + " 条"
          : stage.inputCount + " → " + stage.outputCount + " (-" + dropped + ")";
        return '<div class="stage">' +
          '<div>' + escapeHtml(stageName(stage.name)) + '</div>' +
          '<div class="stage-flow">' + escapeHtml(flow) + '</div>' +
          '<div class="stage-time">' + escapeHtml(stage.durationMs) + 'ms</div>' +
        '</div>';
      }).join("") || '<div class="empty-state">没有记录处理阶段。</div>';
      const results = (report.results || []).map((result) => (
        '<article class="memory-item">' +
          '<div class="memory-meta">' +
            '<span class="chip teal">' + escapeHtml(result.categoryLabel || result.category) + '</span>' +
            '<span class="chip">' + escapeHtml(result.scopeLabel || result.scope) + '</span>' +
            '<span class="chip green">得分 ' + fixed(result.score, 3) + '</span>' +
          '</div>' +
          '<div class="memory-text">' + escapeHtml(result.text) + '</div>' +
        '</article>'
      )).join("") || '<div class="empty-state">没有最终命中的记忆。</div>';

      $("explainOutput").innerHTML =
        '<div class="diagnosis' + diagnosisClass + '">' +
          '<div class="diagnosis-title">' + escapeHtml(explanation.summary || "暂无诊断") + '</div>' +
          (reasons ? '<ul class="plain-list">' + reasons + '</ul>' : "") +
          (suggestions ? '<ul class="plain-list">' + suggestions + '</ul>' : "") +
        '</div>' +
        '<details class="stage-toggle">' +
          '<summary><span class="chart-title">处理阶段</span><span class="subtle">' + traceStages.length + ' 个阶段</span></summary>' +
          '<div class="stage-list">' + stages + '</div>' +
        '</details>' +
        '<div><div class="chart-title">命中结果</div><div class="memory-list">' + results + '</div></div>';
    }

    function renderDetail(memory) {
      $("detailTitle").textContent = memory.categoryLabel + " · " + memory.scopeLabel;
      const detail = memory.details || {};
      $("detailBody").innerHTML =
        '<div class="detail-grid">' +
          '<div class="config-item"><div class="config-label">创建时间</div><div class="config-value">' + escapeHtml(memory.timeLabel) + '</div></div>' +
          '<div class="config-item"><div class="config-label">重要性</div><div class="config-value">' + pct(memory.importance) + '</div></div>' +
          '<div class="config-item"><div class="config-label">置信度</div><div class="config-value">' + pct(memory.confidence) + '</div></div>' +
          '<div class="config-item"><div class="config-label">访问次数</div><div class="config-value">' + escapeHtml(memory.accessCount) + '</div></div>' +
          '<div class="config-item"><div class="config-label">来源</div><div class="config-value">' + escapeHtml(memory.sourceLabel) + '</div></div>' +
          '<div class="config-item"><div class="config-label">记忆层级</div><div class="config-value">' + escapeHtml(memory.tierLabel) + '</div></div>' +
          '<div class="config-item"><div class="config-label">质量标记</div><div class="config-value">' + escapeHtml((memory.qualityFlags || []).map(qualityLabel).join("、") || "无") + '</div></div>' +
        '</div>' +
        '<section class="detail-section"><h3>L0 摘要</h3><p class="detail-text">' + escapeHtml(detail.l0 || memory.preview) + '</p></section>' +
        '<section class="detail-section"><h3>L1 概览</h3><p class="detail-text">' + escapeHtml(detail.l1 || "") + '</p></section>' +
        '<section class="detail-section"><h3>L2 原文/叙事</h3><p class="detail-text">' + escapeHtml(detail.l2 || memory.text) + '</p></section>';
      $("detailOverlay").classList.add("open");
    }

    function closeDetail() {
      $("detailOverlay").classList.remove("open");
    }

    async function deleteMemory(id) {
      const memory = state.memoriesById.get(id);
      const label = memory ? memory.categoryLabel + " · " + memory.scopeLabel : id;
      if (!confirm("确定删除这条记忆吗？\\n" + label)) return;
      const filters = currentFilters();
      await fetchJson("/api/memories/" + encodeURIComponent(id) + queryString({ scope: filters.scope }), {
        method: "DELETE"
      });
      closeDetail();
      if (isMemoriesView()) {
        await loadMemories({ reset: true });
      } else {
        await refresh();
      }
    }

    function renderError(targetId, message) {
      $(targetId).innerHTML = '<div class="alert danger"><div class="alert-title">请求失败</div><div class="subtle">' + escapeHtml(message) + '</div></div>';
    }

    function isMemoriesView() {
      return window.location.pathname === "/memories";
    }

    function setViewFromPath() {
      const memoriesView = isMemoriesView();
      document.body.dataset.view = memoriesView ? "memories" : "dashboard";
      $("overviewLink").classList.toggle("active", !memoriesView);
      $("memoriesLink").classList.toggle("active", memoriesView);
    }

    async function loadMemories(options) {
      const reset = Boolean(options && options.reset);
      if (state.memoriesBusy) return;
      state.memoriesBusy = true;
      if (reset) {
        state.memoryOffset = 0;
        state.hasMoreMemories = true;
        $("masonryMemories").innerHTML = '<div class="empty-state">正在读取记忆...</div>';
      }
      $("loadMoreBtn").disabled = true;
      $("loadMoreBtn").innerHTML = '<span class="spinner"></span>';
      try {
        const filters = currentFilters();
        const offset = reset ? 0 : state.memoryOffset;
        const payload = await fetchJson("/api/memories" + queryString({
          scope: filters.scope,
          category: filters.category,
          quality: filters.quality,
          limit: state.memoryLimit,
          offset
        }));
        state.memoryOffset = offset + payload.memories.length;
        state.hasMoreMemories = payload.memories.length >= state.memoryLimit;
        renderMemoryPage(payload.memories, reset);
      } catch (error) {
        renderError("masonryMemories", error.message || String(error));
      } finally {
        state.memoriesBusy = false;
        $("loadMoreBtn").textContent = "加载更多";
        $("loadMoreBtn").disabled = !state.hasMoreMemories;
      }
    }

    async function refresh() {
      if (state.busy) return;
      setViewFromPath();
      state.busy = true;
      $("refreshBtn").innerHTML = '<span class="spinner"></span>';
      try {
        const filters = currentFilters();
        const summary = await fetchJson("/api/summary" + queryString(filters));
        state.summary = summary;
        renderScopeOptions(summary.scopes.available, filters.scope);
        renderKpis(summary);
        renderCharts(summary);
        renderFeedbackLoop(summary);
        $("lastUpdated").textContent = "更新时间 " + new Date(summary.generatedAt).toLocaleString("zh-CN");
        if (isMemoriesView()) await loadMemories({ reset: true });
      } catch (error) {
        $("lastUpdated").textContent = "读取失败：" + (error.message || String(error));
      } finally {
        state.busy = false;
        $("refreshBtn").textContent = "↻";
      }
    }

    async function explain() {
      const query = $("queryInput").value.trim();
      if (!query) {
        $("explainOutput").innerHTML = '<div class="empty-state">暂无召回诊断。</div>';
        return;
      }
      $("explainBtn").disabled = true;
      $("explainBtn").innerHTML = '<span class="spinner"></span>';
      try {
        const filters = currentFilters();
        const report = await fetchJson("/api/explain" + queryString({
          query,
          limit: $("limitInput").value,
          scope: filters.scope,
          category: filters.category
        }));
        renderExplain(report);
      } catch (error) {
        renderError("explainOutput", error.message || String(error));
      } finally {
        $("explainBtn").disabled = false;
        $("explainBtn").textContent = "诊断";
      }
    }

    $("refreshBtn").addEventListener("click", refresh);
    $("scopeFilter").addEventListener("change", refresh);
    $("categoryFilter").addEventListener("change", refresh);
    $("qualityFilter").addEventListener("change", refresh);
    $("explainBtn").addEventListener("click", explain);
    $("loadMoreBtn").addEventListener("click", () => {
      loadMemories({ reset: false }).catch((error) => alert(error.message || String(error)));
    });
    $("masonryMemories").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (button) {
        const id = button.getAttribute("data-id");
        if (!id) return;
        if (button.getAttribute("data-action") === "delete") {
          deleteMemory(id).catch((error) => alert(error.message || String(error)));
        }
        return;
      }

      const item = event.target.closest(".memory-item[data-id]");
      const id = item && item.getAttribute("data-id");
      if (id) {
        const memory = state.memoriesById.get(id);
        if (memory) renderDetail(memory);
      }
    });
    $("detailCloseBtn").addEventListener("click", closeDetail);
    $("detailOverlay").addEventListener("click", (event) => {
      if (event.target === $("detailOverlay")) closeDetail();
    });
    $("queryInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") explain();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDetail();
    });

    setViewFromPath();
    refresh();
    setInterval(() => {
      if (!isMemoriesView()) refresh();
    }, 30000);
  </script>
</body>
</html>`;
