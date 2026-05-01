import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtractionStats } from "./memory-categories.js";
import type { RetrievalTrace } from "./retrieval-trace.js";
import { RetrievalStatsCollector, type AggregateStats } from "./retrieval-stats.js";

export interface TelemetryConfig {
  persist?: boolean;
  dir?: string;
  maxRecords?: number;
  sampleRate?: number;
}

export interface ParsedTelemetryConfig {
  persist: boolean;
  dir?: string;
  maxRecords: number;
  sampleRate: number;
}

export interface RetrievalTelemetryRecord {
  kind: "retrieval";
  recordedAt: number;
  source: string;
  trace: RetrievalTrace;
}

export interface ExtractionTelemetryRecord {
  kind: "extraction";
  recordedAt: number;
  sessionKey: string;
  scope: string;
  stats: ExtractionStats;
}

export interface ExtractionTelemetrySummary {
  totalRuns: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCreated: number;
  totalMerged: number;
  totalSkipped: number;
  totalRejected: number;
}

type TelemetryRecord = RetrievalTelemetryRecord | ExtractionTelemetryRecord;

const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_SAMPLE_RATE = 1;
const TRIM_EVERY_N_APPENDS = 50;

const writeQueues = new Map<string, Promise<void>>();
const pendingAppends = new Map<string, number>();

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

async function withWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  writeQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}

export function normalizeTelemetryConfig(
  value: unknown,
): ParsedTelemetryConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const maxRecordsRaw = Number(raw.maxRecords);
  const sampleRateRaw = Number(raw.sampleRate);
  const maxRecords = Number.isFinite(maxRecordsRaw)
    ? Math.max(1, Math.min(50_000, Math.floor(maxRecordsRaw)))
    : DEFAULT_MAX_RECORDS;
  const sampleRate = clamp01(sampleRateRaw, DEFAULT_SAMPLE_RATE);

  return {
    persist: raw.persist !== false,
    dir: typeof raw.dir === "string" && raw.dir.trim().length > 0 ? raw.dir.trim() : undefined,
    maxRecords,
    sampleRate,
  };
}

export function resolveTelemetryDir(
  dbPath: string,
  configuredDir?: string,
): string {
  return configuredDir ?? join(dbPath, "..", "telemetry");
}

export async function appendJsonlRecord(
  filePath: string,
  record: TelemetryRecord,
  maxRecords: number,
): Promise<void> {
  await withWriteQueue(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");

    const count = (pendingAppends.get(filePath) ?? 0) + 1;
    if (count >= TRIM_EVERY_N_APPENDS) {
      pendingAppends.set(filePath, 0);
      await trimJsonlFile(filePath, maxRecords);
    } else {
      pendingAppends.set(filePath, count);
    }
  });
}

export async function trimJsonlFile(filePath: string, maxRecords: number): Promise<void> {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return;
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw) return;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= maxRecords) return;
  const trimmed = `${lines.slice(lines.length - maxRecords).join("\n")}\n`;
  await writeFile(filePath, trimmed, "utf8");
}

export async function readJsonlRecords<T>(
  filePath: string,
  limit?: number,
): Promise<T[]> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (!raw) return [];

  const entries: T[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      // Skip truncated or corrupt lines.
    }
  }
  if (!limit || entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}

export function buildRetrievalSummary(
  records: RetrievalTelemetryRecord[],
): AggregateStats {
  const collector = new RetrievalStatsCollector(Math.max(records.length, 1));
  for (const record of records) {
    collector.recordQuery(record.trace, record.source);
  }
  return collector.getStats();
}

export function buildExtractionSummary(
  records: ExtractionTelemetryRecord[],
): ExtractionTelemetrySummary {
  if (records.length === 0) {
    return {
      totalRuns: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      totalCreated: 0,
      totalMerged: 0,
      totalSkipped: 0,
      totalRejected: 0,
    };
  }

  const latencies = records
    .map((record) => record.stats.telemetry?.totalMs ?? 0)
    .sort((left, right) => left - right);
  const p95Index = Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1);

  let totalLatency = 0;
  let totalCreated = 0;
  let totalMerged = 0;
  let totalSkipped = 0;
  let totalRejected = 0;

  for (const record of records) {
    totalLatency += record.stats.telemetry?.totalMs ?? 0;
    totalCreated += record.stats.created;
    totalMerged += record.stats.merged;
    totalSkipped += record.stats.skipped;
    totalRejected += record.stats.rejected ?? 0;
  }

  return {
    totalRuns: records.length,
    avgLatencyMs: Math.round(totalLatency / records.length),
    p95LatencyMs: latencies[p95Index] ?? 0,
    totalCreated,
    totalMerged,
    totalSkipped,
    totalRejected,
  };
}

export function getTelemetryFilePaths(dir: string): {
  retrieval: string;
  extraction: string;
} {
  return {
    retrieval: join(dir, "retrieval.jsonl"),
    extraction: join(dir, "extraction.jsonl"),
  };
}

export class TelemetryStore {
  private readonly files: ReturnType<typeof getTelemetryFilePaths>;

  constructor(private readonly config: ParsedTelemetryConfig, telemetryDir: string) {
    this.files = getTelemetryFilePaths(telemetryDir);
  }

  get enabled(): boolean {
    return this.config.persist;
  }

  get dir(): string {
    return dirname(this.files.retrieval);
  }

  get filePaths(): { retrieval: string; extraction: string } {
    return { ...this.files };
  }

  async recordRetrieval(trace: RetrievalTrace, source: string): Promise<void> {
    if (!this.config.persist || Math.random() > this.config.sampleRate) return;
    const record: RetrievalTelemetryRecord = {
      kind: "retrieval",
      recordedAt: Date.now(),
      source,
      trace,
    };
    await appendJsonlRecord(this.files.retrieval, record, this.config.maxRecords);
  }

  async recordExtraction(
    sessionKey: string,
    scope: string,
    stats: ExtractionStats,
  ): Promise<void> {
    if (!this.config.persist || Math.random() > this.config.sampleRate) return;
    const record: ExtractionTelemetryRecord = {
      kind: "extraction",
      recordedAt: Date.now(),
      sessionKey,
      scope,
      stats,
    };
    await appendJsonlRecord(this.files.extraction, record, this.config.maxRecords);
  }

  async getPersistentSummary(limit = this.config.maxRecords): Promise<{
    retrieval: AggregateStats | null;
    extraction: ExtractionTelemetrySummary | null;
  }> {
    const [retrievalRecords, extractionRecords] = await Promise.all([
      readJsonlRecords<RetrievalTelemetryRecord>(this.files.retrieval, limit),
      readJsonlRecords<ExtractionTelemetryRecord>(this.files.extraction, limit),
    ]);

    return {
      retrieval: retrievalRecords.length > 0 ? buildRetrievalSummary(retrievalRecords) : null,
      extraction: extractionRecords.length > 0 ? buildExtractionSummary(extractionRecords) : null,
    };
  }
}
