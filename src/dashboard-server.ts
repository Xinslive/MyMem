import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryStore, StoreIndexStatus } from "./store.js";
import { createRetriever, type MemoryRetriever, type RetrievalDiagnostics } from "./retriever.js";
import { explainMemoryRetrieval } from "./retrieval-explain.js";
import {
  isMemoryActiveAt,
  isMemoryExpired,
  parseSmartMetadata,
  getCorruptMetadataStats,
  reverseMapLegacyCategory,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { hasActiveRecallSuppression } from "./recall-suppression.js";
import { redactPII, redactSecrets } from "./session-utils.js";
import { clampInt } from "./utils.js";
import type { FeedbackLoopStatus } from "./feedback-loop.js";
import { writeTextFileAtomic } from "./file-utils.js";

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
  /**
   * Optional absolute path to the LanceDB store. Used as the default parent
   * directory for the auto-generated dashboard auth-token file
   * (`.dashboard-token`). When omitted, the token must be supplied via
   * `MemoryDashboardServerOptions.authToken`.
   */
  dbPath?: string;
}

export interface MemoryDashboardServerOptions {
  host?: string;
  port?: number;
  /**
   * Auth token required for all /api/* requests. The browser-side dashboard
   * reads this token from the `?token=` query parameter and sends it back as
   * the `X-Dashboard-Token` header. When omitted, the server generates one,
   * writes it to a file under the configured dbPath, and logs the token
   * (once) on startup. Required because the dashboard runs on 127.0.0.1
   * and any other local process could otherwise read/write the entire
   * memory store.
   */
  authToken?: string;
  /**
   * Absolute path to the auth-token file. Defaults to `<resolvedDbPath>/.dashboard-token`.
   * Ignored when `authToken` is supplied directly. The file is created with
   * mode 0o600 if the server generates a new token.
   */
  authTokenFile?: string;
}

export interface RunningMemoryDashboardServer {
  url: string;
  host: string;
  port: number;
  /** Auth token required by /api/* routes. Callers that need to embed it in HTML should use this. */
  authToken: string;
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
  learning: {
    kind: string;
    utilityScore: number;
    utilitySuccessCount: number;
    utilityFailureCount: number;
    utilityTrialCount: number;
  };
  qualityFlags: DashboardQualityFilter[];
  details: {
    summary: string;
    content: string;
    factKey?: string;
    validFrom: number;
    invalidatedAt?: number;
  };
  validUntil?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 1314;
const DEFAULT_DASHBOARD_TOKEN_FILE = ".dashboard-token";

/**
 * Resolve the auth token used to gate /api/* requests. The token is required
 * to defend against local malicious processes reading/writing the store via
 * the dashboard, even though the listener is bound to loopback (audit #4).
 *
 * Resolution order:
 *   1. `options.authToken` if supplied
 *   2. existing token file at `options.authTokenFile` or `<dbPath>/.dashboard-token`
 *   3. newly generated random token (also written to disk, mode 0o600)
 *
 * The resolved token is returned alongside the chosen file path so the
 * server can inject it into the dashboard HTML and surface it via the
 * `X-Dashboard-Token` header from the front-end.
 */
async function resolveAuthToken(
  context: MemoryDashboardContext,
  options: MemoryDashboardServerOptions,
): Promise<{ token: string; tokenFile: string | null; generated: boolean }> {
  if (typeof options.authToken === "string" && options.authToken.length > 0) {
    return { token: options.authToken, tokenFile: null, generated: false };
  }
  const tokenFile = options.authTokenFile
    ?? (context.dbPath ? join(context.dbPath, DEFAULT_DASHBOARD_TOKEN_FILE) : null);
  if (!tokenFile) {
    // No persistent location and no caller-supplied token: refuse to start
    // an unauthenticated server.
    throw new Error(
      "dashboard auth token required: pass `authToken` or `authTokenFile`, or set `context.dbPath`",
    );
  }
  try {
    const existing = await readFile(tokenFile, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length >= 16) {
      return { token: trimmed, tokenFile, generated: false };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Permission errors etc. — surface to caller.
      throw err;
    }
  }
  const generatedToken = randomBytes(24).toString("base64url");
  await writeTextFileAtomic(tokenFile, generatedToken);
  return { token: generatedToken, tokenFile, generated: true };
}

/**
 * Constant-time string comparison to avoid timing oracles on the dashboard
 * auth token. The token is short (43 base64url chars), so the comparison
 * should always be cheap; the constant-time bit only matters for paranoia.
 */
function safeTokenEquals(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Extract the auth token from an incoming request: prefer the explicit
 * `X-Dashboard-Token` header, fall back to the `?token=` query param so
 * the same-origin browser-side fetch can pass it through after the user
 * lands on the dashboard via a one-time URL.
 */
function extractRequestToken(req: IncomingMessage, url: URL): string | null {
  const headerToken = req.headers["x-dashboard-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) return headerToken;
  if (Array.isArray(headerToken) && headerToken[0]?.length) return headerToken[0];
  const queryToken = url.searchParams.get("token");
  return queryToken && queryToken.length > 0 ? queryToken : null;
}
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
  const rawCategory = singleParam(url, "category");
  const category = rawCategory && MEMORY_CATEGORY_KEYS.includes(rawCategory)
    ? rawCategory
    : undefined;
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

/** Escape a value for safe inclusion in a double-quoted HTML attribute. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function stripMemoryLabelPrefix(text: string): string {
  return text
    .replace(/^(?:skill|pattern|scene|case|pitfall|preference|entity|profile|event|decision)\s*[:：]\s*/i, "")
    .replace(/^(?:需要|问题|风险|偏好|背景|详情|记录|计划|总结)\s*[-—:：]\s*/u, "")
    .replace(/^(?:需要|问题|风险|偏好|背景|详情|记录|计划|总结)\s+(?=.{8,})/u, "")
    .trim();
}

function firstBulletLine(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => stripMemoryLabelPrefix(line.replace(/^\s*[-*•]\s*/u, "")))
    .filter((line) => line.length >= 12);
  return lines[0] ?? "";
}

function firstMeaningfulSentence(text: string): string {
  const bullet = firstBulletLine(text);
  if (bullet) return bullet;
  const normalized = stripMemoryLabelPrefix(text.replace(/^[\s-]+/gm, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim());
  const match = normalized.match(/^.{12,160}?[。！？.!?](?=\s|$)/u);
  return (match?.[0] ?? normalized).trim();
}

function isLowSignalSummary(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  const stripped = stripMemoryLabelPrefix(normalized);
  if (!stripped) return true;
  if (/^(?:skill|pattern|scene|case|pitfall|preference|entity|profile|event|decision)\s*[:：]/i.test(normalized)) return true;
  if (/^(?:需要|问题|风险|偏好|背景|详情|记录|计划|总结)$/u.test(stripped)) return true;
  if (stripped.length < 14 && !/[：:，,。！？.!?、]/u.test(stripped)) return true;
  return stripped.length < 10 && !/[。！？.!?，,、]/u.test(stripped);
}

function buildMemoryPreview(summary: string, content: string, text: string): string {
  const cleanSummary = displayMemoryText(summary);
  const cleanContent = displayMemoryText(content);
  const cleanText = displayMemoryText(text);
  const source = cleanSummary && !isLowSignalSummary(cleanSummary)
    ? cleanSummary
    : firstMeaningfulSentence(cleanContent || cleanText);
  return truncateText(source || cleanText, 180);
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
  return redactPII(redactSecrets(text))
    .replace(/\bother:agent:[\w.-]+/g, "other")
    .replace(/\breflection:agent:([\w.-]+)/g, "$1")
    .replace(/\bagent:([\w.-]+)/g, "$1");
}

function displayCategory(category: string): string {
  return MEMORY_CATEGORY_LABELS[category] ?? category;
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
    case "soft_cutoff":
      return "软阈值过滤";
    case "candidate_cap":
      return "候选上限";
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
    case "learning_policy":
      return "学习策略";
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
  const summary = displayMemoryText(meta.summary);
  const content = displayMemoryText(meta.content);
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
    preview: buildMemoryPreview(summary, content, safeText),
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
    learning: {
      kind: meta.memory_kind,
      utilityScore: meta.utility_score,
      utilitySuccessCount: meta.utility_success_count,
      utilityFailureCount: meta.utility_failure_count,
      utilityTrialCount: meta.utility_trial_count,
    },
    qualityFlags,
    details: {
      summary,
      content,
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
  corruptMetadata?: { count: number; lastError: { at: number; message: string; rawPreview: string } | null };
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

  if (params.corruptMetadata && params.corruptMetadata.count > 0) {
    alerts.push({
      level: "danger",
      title: "存在 corrupt 记忆元数据",
      detail:
        `本进程内检测到 ${params.corruptMetadata.count} 条 metadata 解析失败。` +
        (params.corruptMetadata.lastError
          ? `最近一次：${params.corruptMetadata.lastError.message}。建议执行 mymem doctor 排查。`
          : "建议执行 mymem doctor 排查。"),
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
      corruptMetadata: getCorruptMetadataStats(),
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
  const pageSize = 1_000;
  const collected: DashboardMemory[] = [];
  let rawOffset = 0;
  let scanned = 0;
  const maxScanned = Math.min(10_000, (safeOffset + target) * 4 + pageSize);
  const storeFilters = filter.quality ? { quality: filter.quality } : undefined;

  while (collected.length < safeOffset + target && scanned < maxScanned) {
    const page = await context.store.list(filter.scopeFilter, undefined, pageSize, rawOffset, storeFilters);
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
    source: "auto-recall",
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
  authToken: string,
): Promise<void> {
  const host = req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  // /api/* requires a valid token; static HTML is served unauthenticated so
  // the browser can land on the page (the front-end then includes the token
  // via meta tag or query string for subsequent fetches).
  const requiresAuth = url.pathname.startsWith("/api/") || req.method === "DELETE";
  if (requiresAuth) {
    const provided = extractRequestToken(req, url);
    if (!safeTokenEquals(provided, authToken)) {
      sendJson(res, 401, { error: "unauthorized", message: "缺少或错误的仪表盘访问令牌。" });
      return;
    }
  }

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
      // Inject the auth token into the served HTML so the front-end can echo
      // it back via the X-Dashboard-Token header on subsequent fetches.
      // The token is also accepted via ?token= query string for the initial
      // landing; strip it from the URL so it does not leak via Referer.
      const dashboardHtml = await loadDashboardHtml();
      const sanitizedHtml = dashboardHtml.replace(
        "__DASHBOARD_AUTH_TOKEN__",
        escapeHtmlAttr(authToken),
      );
      sendHtml(res, sanitizedHtml);
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

  const { token: authToken, tokenFile, generated } = await resolveAuthToken(context, options);

  // Capture for closure; the same token is injected into the dashboard HTML so
  // the front-end can echo it back on every fetch.
  const server = createServer((req, res) => {
    void routeDashboardRequest(context, req, res, authToken);
  });
  // Audit #36: cap concurrent sockets and prevent idle keep-alive leaks.
  server.maxConnections = 64;
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

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
  if (generated) {
    console.warn(
      `[mymem] dashboard auth token written to ${tokenFile} — start a browser at http://${host}:${resolvedPort}/?token=${authToken} to use the dashboard`,
    );
  }
  return {
    host,
    port: resolvedPort,
    authToken,
    url: `http://${host}:${resolvedPort}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const DASHBOARD_HTML_URL = new URL("./dashboard/assets/index.html", import.meta.url);
let dashboardHtmlCache: string | null = null;

async function loadDashboardHtml(): Promise<string> {
  if (dashboardHtmlCache === null) {
    dashboardHtmlCache = await readFile(DASHBOARD_HTML_URL, "utf8");
  }
  return dashboardHtmlCache;
}
