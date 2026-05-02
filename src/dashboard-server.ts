import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryStore, StoreIndexStatus } from "./store.js";
import { createRetriever, type MemoryRetriever, type RetrievalDiagnostics } from "./retriever.js";
import { explainMemoryRetrieval } from "./retrieval-explain.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import {
  isMemoryActiveAt,
  isMemoryExpired,
  parseSmartMetadata,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { redactSecrets } from "./session-utils.js";
import { clampInt } from "./utils.js";

type DashboardStore = Pick<MemoryStore, "stats" | "list" | "hasFtsSupport"> & {
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
};

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
  rawCategory: MemoryEntry["category"];
  scope: string;
  importance: number;
  timestamp: number;
  ageLabel: string;
  status: "active" | "archived" | "expired" | "inactive";
  tier: string;
  confidence: number;
  accessCount: number;
  source: string;
  validUntil?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 1314;

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
  return {
    scopeFilter: scope ? [scope] : undefined,
    category,
  };
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
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  const diffMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

function memoryStatus(meta: SmartMemoryMetadata): DashboardMemory["status"] {
  if (meta.state === "archived") return "archived";
  if (isMemoryExpired(meta)) return "expired";
  if (!isMemoryActiveAt(meta)) return "inactive";
  return "active";
}

function serializeMemory(entry: MemoryEntry): DashboardMemory {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const safeText = redactSecrets(entry.text);
  return {
    id: entry.id,
    text: safeText,
    preview: truncateText(safeText, 180),
    category: getDisplayCategoryTag(entry),
    rawCategory: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    timestamp: entry.timestamp,
    ageLabel: ageLabel(entry.timestamp),
    status: memoryStatus(meta),
    tier: String(meta.memory_tier || meta.tier || meta.memory_layer || "working"),
    confidence: meta.confidence,
    accessCount: meta.access_count,
    source: String(meta.source || "unknown"),
    ...(meta.valid_until ? { validUntil: meta.valid_until } : {}),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
      title: "No memories yet",
      detail: "The store is reachable, but there are no visible memories for the current filter.",
    });
  }

  if (params.retrievalMode === "hybrid" && !params.hasFtsSupport) {
    alerts.push({
      level: "warning",
      title: "Keyword index unavailable",
      detail: "Hybrid search can still run, but keyword matching may be weaker until FTS is rebuilt.",
    });
  }

  if (params.ftsStatus?.lastError) {
    alerts.push({
      level: "danger",
      title: "FTS reported an error",
      detail: params.ftsStatus.lastError,
    });
  }

  if (params.indexStatus?.vectorIndexPending) {
    alerts.push({
      level: "warning",
      title: "Vector index pending",
      detail: "The table is still small enough for exhaustive vector search, or an index has not been created yet.",
    });
  }

  if ((params.indexStatus?.missingRecommendedScalars.length ?? 0) > 0) {
    alerts.push({
      level: "warning",
      title: "Recommended scalar indexes missing",
      detail: params.indexStatus?.missingRecommendedScalars.join(", ") ?? "",
    });
  }

  if (params.healthSignals.badRecall > 0 || params.healthSignals.suppressed > 0 || params.healthSignals.lowConfidence > 0) {
    alerts.push({
      level: "warning",
      title: "Memory quality signals need attention",
      detail: `${params.healthSignals.badRecall} bad recall, ${params.healthSignals.suppressed} suppressed, ${params.healthSignals.lowConfidence} low confidence.`,
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      level: "ok",
      title: "Store looks healthy",
      detail: "No dashboard-level warnings for the current filter.",
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
  const [stats, recent, indexStatus] = await Promise.all([
    context.store.stats(filter.scopeFilter),
    context.store.list(filter.scopeFilter, filter.category, 24, 0),
    optionalIndexStatus(context.store),
  ]);
  const ftsStatus = optionalFtsStatus(context.store);
  const scopeStats = context.scopeManager.getStats?.() ?? {
    totalScopes: collectScopes(context, stats.scopeCounts).length,
    agentsWithCustomAccess: 0,
    scopesByType: {},
  };

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      scope: filter.scopeFilter?.[0] ?? null,
      category: filter.category ?? null,
    },
    memory: stats,
    scopes: {
      ...scopeStats,
      available: collectScopes(context, stats.scopeCounts),
    },
    retrieval: {
      ...publicRetrievalConfig(retrievalConfig),
      hasFtsSupport: context.store.hasFtsSupport,
      ftsStatus,
      indexStatus,
    },
    recent: recent.map(serializeMemory),
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
  const rows = await context.store.list(filter.scopeFilter, filter.category, limit, offset);
  return {
    filters: {
      scope: filter.scopeFilter?.[0] ?? null,
      category: filter.category ?? null,
      limit,
      offset,
    },
    count: rows.length,
    memories: rows.map(serializeMemory),
  };
}

function resolveExplainRetriever(context: MemoryDashboardContext): Pick<
  MemoryRetriever,
  "retrieveWithTrace" | "getConfig" | "getLastDiagnostics"
> {
  if (context.embedder) {
    return createRetriever(
      context.store as MemoryStore,
      context.embedder,
      context.retriever.getConfig(),
    );
  }

  if (typeof context.retriever.retrieveWithTrace !== "function") {
    throw new Error("Dashboard explain requires an embedder or a retriever with retrieveWithTrace().");
  }

  return {
    retrieveWithTrace: context.retriever.retrieveWithTrace.bind(context.retriever),
    getConfig: context.retriever.getConfig.bind(context.retriever),
    getLastDiagnostics: typeof context.retriever.getLastDiagnostics === "function"
      ? context.retriever.getLastDiagnostics.bind(context.retriever)
      : (() => null as RetrievalDiagnostics | null),
  };
}

async function buildExplainReport(context: MemoryDashboardContext, url: URL) {
  const query = singleParam(url, "query");
  if (!query) {
    return {
      statusCode: 400,
      payload: {
        error: "query_required",
        message: "query is required",
      },
    };
  }

  const filter = resolveFilter(url);
  const limit = numberParam(url, "limit", 5, 1, 20);
  const retriever = resolveExplainRetriever(context);
  const report = await explainMemoryRetrieval(retriever, {
    query,
    limit,
    scopeFilter: filter.scopeFilter,
    category: filter.category,
    source: "cli",
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
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
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

    sendJson(res, 404, { error: "not_found" });
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
  <title>MyMem Dashboard</title>
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
      gap: 16px;
    }
    .chart-title {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: minmax(90px, 0.9fr) minmax(100px, 1.8fr) 44px;
      gap: 10px;
      align-items: center;
      min-height: 28px;
      font-size: 13px;
    }
    .bar-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-track {
      height: 10px;
      background: #edf1f6;
      border-radius: 999px;
      overflow: hidden;
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
      text-align: right;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .memory-list {
      display: grid;
      gap: 10px;
    }
    .memory-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel-soft);
      min-width: 0;
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
      grid-template-columns: minmax(180px, 1fr) 92px 110px;
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
    .status-list {
      display: grid;
      gap: 10px;
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
      .toolbar select, .toolbar button {
        flex: 1 1 130px;
      }
      .layout { padding: 12px; }
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .charts { grid-template-columns: 1fr; }
      .explain-form { grid-template-columns: 1fr; }
      .memory-stats { grid-template-columns: 1fr; }
      .config-grid { grid-template-columns: 1fr; }
      .stage { grid-template-columns: 1fr 70px 70px; }
    }
    @media (max-width: 440px) {
      .kpis { grid-template-columns: 1fr; }
      .metric { min-height: 92px; }
      .bar-row { grid-template-columns: minmax(70px, 1fr) minmax(80px, 1.2fr) 36px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-mark">M</div>
          <div>
            <h1>MyMem Dashboard</h1>
            <div class="subtle" id="lastUpdated">Loading local memory state</div>
          </div>
        </div>
        <div class="toolbar">
          <select id="scopeFilter" aria-label="Scope"></select>
          <select id="categoryFilter" aria-label="Category">
            <option value="">All categories</option>
            <option value="preference">Preference</option>
            <option value="fact">Fact</option>
            <option value="decision">Decision</option>
            <option value="entity">Entity</option>
            <option value="reflection">Reflection</option>
            <option value="other">Other</option>
          </select>
          <button class="icon" id="refreshBtn" title="Refresh" aria-label="Refresh">↻</button>
        </div>
      </div>
    </header>

    <main class="layout">
      <section class="kpis" aria-label="Overview">
        <div class="metric">
          <div class="metric-label">Visible memories</div>
          <div class="metric-value" id="kpiTotal">--</div>
          <div class="metric-foot" id="kpiRecent">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">Scopes</div>
          <div class="metric-value" id="kpiScopes">--</div>
          <div class="metric-foot" id="kpiAgents">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">Retrieval</div>
          <div class="metric-value" id="kpiMode">--</div>
          <div class="metric-foot" id="kpiFts">--</div>
        </div>
        <div class="metric">
          <div class="metric-label">Quality signals</div>
          <div class="metric-value" id="kpiQuality">--</div>
          <div class="metric-foot">bad recall / suppressed / low confidence</div>
        </div>
        <div class="metric">
          <div class="metric-label">Candidate pool</div>
          <div class="metric-value" id="kpiPool">--</div>
          <div class="metric-foot" id="kpiThresholds">--</div>
        </div>
      </section>

      <section class="grid">
        <div class="column">
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Distribution</h2>
              <span class="subtle" id="distributionHint">--</span>
            </div>
            <div class="panel-body">
              <div class="charts">
                <div>
                  <div class="chart-title">By scope</div>
                  <div id="scopeChart"></div>
                </div>
                <div>
                  <div class="chart-title">By category</div>
                  <div id="categoryChart"></div>
                </div>
                <div>
                  <div class="chart-title">By tier</div>
                  <div id="tierChart"></div>
                </div>
                <div>
                  <div class="chart-title">Recent activity</div>
                  <div id="activityChart"></div>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Recall Explain</h2>
              <span class="subtle" id="explainCount">No query yet</span>
            </div>
            <div class="panel-body">
              <div class="explain-form">
                <input id="queryInput" placeholder="Memory query" aria-label="Query">
                <select id="limitInput" aria-label="Limit">
                  <option value="3">Top 3</option>
                  <option value="5" selected>Top 5</option>
                  <option value="10">Top 10</option>
                </select>
                <button class="primary" id="explainBtn">Explain</button>
              </div>
              <div class="explain-output" id="explainOutput">
                <div class="empty-state">No recall diagnosis yet.</div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Recent Memories</h2>
              <span class="subtle" id="recentCount">--</span>
            </div>
            <div class="panel-body">
              <div class="memory-list" id="recentMemories"></div>
            </div>
          </section>
        </div>

        <aside class="column">
          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Status</h2>
              <span class="subtle">Local only</span>
            </div>
            <div class="panel-body">
              <div class="status-list" id="alerts"></div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Retrieval Settings</h2>
              <span class="subtle" id="settingsMode">--</span>
            </div>
            <div class="panel-body">
              <div class="config-grid" id="configGrid"></div>
            </div>
          </section>
        </aside>
      </section>
    </main>
  </div>

  <script>
    const state = {
      summary: null,
      busy: false
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

    function currentFilters() {
      const scope = $("scopeFilter").value;
      const category = $("categoryFilter").value;
      return {
        scope,
        category
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

    async function fetchJson(path) {
      const response = await fetch(path, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "request failed");
      }
      return payload;
    }

    function renderScopeOptions(scopes, selected) {
      const select = $("scopeFilter");
      const previous = selected || select.value;
      const options = ['<option value="">All scopes</option>'].concat(
        (scopes || []).map((scope) => '<option value="' + escapeHtml(scope) + '">' + escapeHtml(scope) + '</option>')
      );
      select.innerHTML = options.join("");
      select.value = previous;
    }

    function renderKpis(summary) {
      const memory = summary.memory;
      const retrieval = summary.retrieval;
      const quality = memory.healthSignals || {};
      $("kpiTotal").textContent = memory.totalCount;
      $("kpiRecent").textContent = memory.recentActivity.last24h + " last 24h, " + memory.recentActivity.last7d + " last 7d";
      $("kpiScopes").textContent = summary.scopes.totalScopes;
      $("kpiAgents").textContent = summary.scopes.agentsWithCustomAccess + " custom ACL agents";
      $("kpiMode").textContent = retrieval.mode;
      $("kpiFts").textContent = retrieval.hasFtsSupport ? "Keyword index ready" : "Keyword index unavailable";
      $("kpiQuality").textContent = [quality.badRecall || 0, quality.suppressed || 0, quality.lowConfidence || 0].join(" / ");
      $("kpiPool").textContent = retrieval.candidatePoolSize;
      $("kpiThresholds").textContent = "min " + fixed(retrieval.minScore, 2) + ", hard " + fixed(retrieval.hardMinScore, 2);
      $("distributionHint").textContent = memory.totalCount + " visible";
      $("settingsMode").textContent = retrieval.hasFtsSupport ? "Hybrid ready" : "Vector/fallback";
    }

    function renderBars(targetId, data, className) {
      const target = $(targetId);
      const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) {
        target.innerHTML = '<div class="empty-state">No data</div>';
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

    function renderCharts(summary) {
      renderBars("scopeChart", summary.memory.scopeCounts, "");
      renderBars("categoryChart", summary.memory.categoryCounts, "alt");
      renderBars("tierChart", summary.memory.tierDistribution, "third");
      renderBars("activityChart", {
        "last 24h": summary.memory.recentActivity.last24h,
        "last 7d": summary.memory.recentActivity.last7d,
        "all visible": summary.memory.totalCount
      }, "");
    }

    function statusChip(status) {
      if (status === "active") return '<span class="chip green">active</span>';
      if (status === "archived") return '<span class="chip amber">archived</span>';
      if (status === "expired") return '<span class="chip red">expired</span>';
      return '<span class="chip amber">inactive</span>';
    }

    function renderMemories(memories) {
      $("recentCount").textContent = (memories || []).length + " shown";
      if (!memories || memories.length === 0) {
        $("recentMemories").innerHTML = '<div class="empty-state">No memories for the current filter.</div>';
        return;
      }
      $("recentMemories").innerHTML = memories.map((memory) => (
        '<article class="memory-item">' +
          '<div class="memory-meta">' +
            '<span class="chip teal">' + escapeHtml(memory.category) + '</span>' +
            '<span class="chip">' + escapeHtml(memory.scope) + '</span>' +
            statusChip(memory.status) +
            '<span class="chip">' + escapeHtml(memory.ageLabel) + '</span>' +
          '</div>' +
          '<div class="memory-text">' + escapeHtml(memory.preview) + '</div>' +
          '<div class="memory-stats">' +
            '<span>importance ' + pct(memory.importance) + '</span>' +
            '<span>confidence ' + pct(memory.confidence) + '</span>' +
            '<span>access ' + escapeHtml(memory.accessCount) + '</span>' +
          '</div>' +
        '</article>'
      )).join("");
    }

    function renderAlerts(alerts) {
      $("alerts").innerHTML = (alerts || []).map((alert) => (
        '<div class="alert ' + escapeHtml(alert.level) + '">' +
          '<div class="alert-title">' + escapeHtml(alert.title) + '</div>' +
          '<div class="subtle">' + escapeHtml(alert.detail) + '</div>' +
        '</div>'
      )).join("");
    }

    function renderConfig(summary) {
      const r = summary.retrieval;
      const items = [
        ["Mode", r.mode],
        ["Rerank", r.rerank],
        ["Vector / BM25", fixed(r.vectorWeight, 2) + " / " + fixed(r.bm25Weight, 2)],
        ["Query expansion", r.queryExpansion ? "on" : "off"],
        ["Noise filter", r.filterNoise ? "on" : "off"],
        ["Time decay", r.timeDecayHalfLifeDays + " days"],
        ["Recency", r.recencyHalfLifeDays + " days, " + fixed(r.recencyWeight, 2)],
        ["Tags", (r.tagPrefixes || []).join(", ") || "none"]
      ];
      $("configGrid").innerHTML = items.map(([label, value]) => (
        '<div class="config-item">' +
          '<div class="config-label">' + escapeHtml(label) + '</div>' +
          '<div class="config-value">' + escapeHtml(value) + '</div>' +
        '</div>'
      )).join("");
    }

    function stageName(name) {
      return ({
        parallel_search: "candidate search",
        vector_search: "vector search",
        bm25_search: "keyword search",
        rrf_fusion: "fusion",
        min_score_filter: "min score",
        hard_cutoff: "hard cutoff",
        noise_filter: "noise filter",
        mmr_diversity: "diversity",
        length_normalization: "length norm",
        time_decay: "time decay",
        recency_composite: "recency",
        fallback_scoring: "fallback score"
      })[name] || name;
    }

    function renderExplain(report) {
      const explanation = report.explanation || {};
      $("explainCount").textContent = report.count + " result" + (report.count === 1 ? "" : "s");
      const diagnosisClass = explanation.status === "empty" ? " empty" : explanation.status === "degraded" ? " degraded" : "";
      const reasons = (explanation.reasons || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("");
      const suggestions = (explanation.suggestions || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("");
      const stages = ((report.trace && report.trace.stages) || []).map((stage) => {
        const dropped = Math.max(0, Number(stage.inputCount || 0) - Number(stage.outputCount || 0));
        const flow = Number(stage.inputCount || 0) === 0
          ? "found " + stage.outputCount
          : stage.inputCount + " → " + stage.outputCount + " (-" + dropped + ")";
        return '<div class="stage">' +
          '<div>' + escapeHtml(stageName(stage.name)) + '</div>' +
          '<div class="stage-flow">' + escapeHtml(flow) + '</div>' +
          '<div class="stage-time">' + escapeHtml(stage.durationMs) + 'ms</div>' +
        '</div>';
      }).join("") || '<div class="empty-state">No trace stages recorded.</div>';
      const results = (report.results || []).map((result) => (
        '<article class="memory-item">' +
          '<div class="memory-meta">' +
            '<span class="chip teal">' + escapeHtml(result.category) + '</span>' +
            '<span class="chip">' + escapeHtml(result.scope) + '</span>' +
            '<span class="chip green">score ' + fixed(result.score, 3) + '</span>' +
          '</div>' +
          '<div class="memory-text">' + escapeHtml(result.text) + '</div>' +
        '</article>'
      )).join("") || '<div class="empty-state">No final results.</div>';

      $("explainOutput").innerHTML =
        '<div class="diagnosis' + diagnosisClass + '">' +
          '<div class="diagnosis-title">' + escapeHtml(explanation.summary || "No diagnosis") + '</div>' +
          (reasons ? '<ul class="plain-list">' + reasons + '</ul>' : "") +
          (suggestions ? '<ul class="plain-list">' + suggestions + '</ul>' : "") +
        '</div>' +
        '<div><div class="chart-title">Stages</div><div class="stage-list">' + stages + '</div></div>' +
        '<div><div class="chart-title">Results</div><div class="memory-list">' + results + '</div></div>';
    }

    function renderError(targetId, message) {
      $(targetId).innerHTML = '<div class="alert danger"><div class="alert-title">Request failed</div><div class="subtle">' + escapeHtml(message) + '</div></div>';
    }

    async function refresh() {
      if (state.busy) return;
      state.busy = true;
      $("refreshBtn").innerHTML = '<span class="spinner"></span>';
      try {
        const filters = currentFilters();
        const summary = await fetchJson("/api/summary" + queryString(filters));
        state.summary = summary;
        renderScopeOptions(summary.scopes.available, filters.scope);
        renderKpis(summary);
        renderCharts(summary);
        renderMemories(summary.recent);
        renderAlerts(summary.alerts);
        renderConfig(summary);
        $("lastUpdated").textContent = "Updated " + new Date(summary.generatedAt).toLocaleString();
      } catch (error) {
        renderError("alerts", error.message || String(error));
      } finally {
        state.busy = false;
        $("refreshBtn").textContent = "↻";
      }
    }

    async function explain() {
      const query = $("queryInput").value.trim();
      if (!query) {
        $("explainOutput").innerHTML = '<div class="empty-state">No recall diagnosis yet.</div>';
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
        $("explainBtn").textContent = "Explain";
      }
    }

    $("refreshBtn").addEventListener("click", refresh);
    $("scopeFilter").addEventListener("change", refresh);
    $("categoryFilter").addEventListener("change", refresh);
    $("explainBtn").addEventListener("click", explain);
    $("queryInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") explain();
    });

    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
