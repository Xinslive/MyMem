import { pathToFileURL } from "node:url";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExtractionSummary,
  buildRetrievalSummary,
  readJsonlRecords,
  type ExtractionTelemetryRecord,
  type RetrievalTelemetryRecord,
} from "../src/telemetry.js";
import { MemoryStore, type MemoryEntry } from "../src/store.js";
import { createRetriever } from "../src/retriever.js";
import type { RetrievalResult } from "../src/retriever-types.js";

export interface BenchmarkRunOptions {
  retrievalFile?: string;
  extractionFile?: string;
  limit?: number;
  scenario?: BenchmarkScenario;
  rows?: number;
  iterations?: number;
  baselineFile?: string;
  failOnRegression?: boolean;
}

export interface BenchmarkRunSummary {
  retrieval: ReturnType<typeof buildRetrievalSummary> | null;
  extraction: ReturnType<typeof buildExtractionSummary> | null;
}

export type BenchmarkScenario = "retrieval" | "write" | "stats" | "all";

export interface BenchmarkMetricSummary {
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface BenchmarkScenarioSummary extends BenchmarkMetricSummary {
  zeroResultRate?: number;
  avgResultCount?: number;
}

export interface BenchmarkScenarioRunSummary {
  rows: number;
  iterations: number;
  retrieval?: Record<string, BenchmarkScenarioSummary>;
  write?: Record<string, BenchmarkScenarioSummary>;
  stats?: Record<string, BenchmarkScenarioSummary>;
  regressions?: string[];
}

export async function runBenchmarkSummary(
  options: BenchmarkRunOptions,
): Promise<BenchmarkRunSummary> {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
  const [retrievalRecords, extractionRecords] = await Promise.all([
    options.retrievalFile
      ? readJsonlRecords<RetrievalTelemetryRecord>(options.retrievalFile, limit)
      : Promise.resolve([]),
    options.extractionFile
      ? readJsonlRecords<ExtractionTelemetryRecord>(options.extractionFile, limit)
      : Promise.resolve([]),
  ]);

  return {
    retrieval: retrievalRecords.length > 0 ? buildRetrievalSummary(retrievalRecords) : null,
    extraction: extractionRecords.length > 0 ? buildExtractionSummary(extractionRecords) : null,
  };
}

function deterministicVector(text: string, dimensions = 8): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % dimensions] += ((text.charCodeAt(i) % 23) - 11) / 11;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function makeBenchmarkEntry(i: number): Omit<MemoryEntry, "id" | "timestamp"> {
  const scope = i % 3 === 0 ? "agent:main" : "global";
  const category: MemoryEntry["category"] =
    i % 5 === 0 ? "decision" : i % 3 === 0 ? "preference" : "fact";
  const topic = i % 2 === 0 ? "deployment latency budget" : "memory recall retrieval";
  const tag = i % 7 === 0 ? "proj:bench" : "team:core";
  const text = `benchmark memory ${i} ${topic} ${tag} 中文检索 token ${i % 9}`;
  const metadata = JSON.stringify({
    state: i % 11 === 0 ? "draft" : "confirmed",
    memory_layer: i % 13 === 0 ? "archive" : "working",
    l0_abstract: text,
    l1_overview: `- ${text}`,
    l2_content: text,
    confidence: i % 10 === 0 ? 0.3 : 0.8,
  });
  return {
    text,
    vector: deterministicVector(text),
    category,
    scope,
    importance: 0.5 + (i % 5) * 0.1,
    metadata,
  };
}

async function seedStore(store: MemoryStore, rows: number): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  await store.runBatch(async () => {
    for (let i = 0; i < rows; i++) {
      entries.push(await store.store(makeBenchmarkEntry(i)));
    }
  });
  return entries;
}

function summarizeDurations(durations: number[]): BenchmarkMetricSummary {
  const sorted = [...durations].sort((left, right) => left - right);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const percentile = (p: number) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index] ?? 0;
  };
  return {
    iterations: durations.length,
    avgMs: Math.round((sum / Math.max(1, durations.length)) * 10) / 10,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

async function measureScenario(
  iterations: number,
  action: () => Promise<unknown>,
): Promise<BenchmarkScenarioSummary> {
  const durations: number[] = [];
  let resultCount = 0;
  let zeroResults = 0;

  for (let i = 0; i < iterations; i++) {
    const startedAt = Date.now();
    const result = await action();
    durations.push(Date.now() - startedAt);
    if (Array.isArray(result)) {
      resultCount += result.length;
      if (result.length === 0) zeroResults++;
    }
  }

  return {
    ...summarizeDurations(durations),
    ...(resultCount > 0 || zeroResults > 0
      ? {
          zeroResultRate: Math.round((zeroResults / iterations) * 1000) / 1000,
          avgResultCount: Math.round((resultCount / iterations) * 10) / 10,
        }
      : {}),
  };
}

function createBenchmarkRetriever(store: MemoryStore) {
  return createRetriever(
    store,
    {
      dimensions: 8,
      async embedQuery(query: string) {
        return deterministicVector(query);
      },
      async embedPassage(text: string) {
        return deterministicVector(text);
      },
      async embedBatch(texts: string[]) {
        return texts.map((text) => deterministicVector(text));
      },
      get cacheStats() {
        return { size: 0, hits: 0, misses: 0, hitRate: "N/A" };
      },
    } as never,
    {
      mode: "hybrid",
      rerank: "none",
      minScore: 0.1,
      hardMinScore: 0.1,
      filterNoise: false,
      candidatePoolSize: 10,
    },
  );
}

export async function runBenchmarkScenarios(
  options: BenchmarkRunOptions,
): Promise<BenchmarkScenarioRunSummary> {
  const scenario = options.scenario ?? "all";
  const rows = Math.max(1, Math.floor(options.rows ?? 120));
  const iterations = Math.max(1, Math.floor(options.iterations ?? 10));
  const dir = await mkdtemp(join(tmpdir(), "mymem-benchmark-run-"));
  try {
    const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
    const entries = await seedStore(store, rows);
    const retriever = createBenchmarkRetriever(store);
    const summary: BenchmarkScenarioRunSummary = { rows, iterations };
    let nextWriteIndex = rows;

    if (scenario === "retrieval" || scenario === "all") {
      summary.retrieval = {
        hybrid: await measureScenario(iterations, () =>
          retriever.retrieve({ query: "deployment latency budget", limit: 5, source: "manual" }) as Promise<RetrievalResult[]>,
        ),
        tag: await measureScenario(iterations, () =>
          retriever.retrieve({ query: "proj:bench", limit: 5, source: "manual" }) as Promise<RetrievalResult[]>,
        ),
        autoRecall: await measureScenario(iterations, () =>
          retriever.retrieve({
            query: "memory recall retrieval 中文检索",
            limit: 4,
            source: "auto-recall",
            candidatePoolSize: 8,
            overFetchMultiplier: 4,
            degradeAfterMs: 5_000,
            deadlineAt: Date.now() + 20_000,
          }) as Promise<RetrievalResult[]>,
        ),
      };
    }

    if (scenario === "write" || scenario === "all") {
      summary.write = {
        store: await measureScenario(iterations, async () => {
          await store.store(makeBenchmarkEntry(nextWriteIndex++));
        }),
        runBatch: await measureScenario(iterations, async () => {
          await store.runBatch(async () => {
            for (let i = 0; i < 5; i++) {
              await store.store(makeBenchmarkEntry(nextWriteIndex++));
            }
          });
        }),
        metadataBatch: await measureScenario(iterations, async () => {
          await store.updateBatchMetadata(
            entries.slice(0, Math.min(10, entries.length)).map((entry, index) => ({
              id: entry.id,
              metadata: JSON.stringify({ ...JSON.parse(entry.metadata || "{}"), benchmarkUpdate: index }),
            })),
          );
        }),
      };
    }

    if (scenario === "stats" || scenario === "all") {
      summary.stats = {
        stats: await measureScenario(iterations, () => store.stats(["global"])),
        list: await measureScenario(iterations, () => store.list(["global"], undefined, 20, 0)),
      };
    }

    if (options.baselineFile) {
      summary.regressions = await compareBenchmarkBaseline(summary, options.baselineFile);
      if (options.failOnRegression && summary.regressions.length > 0) {
        throw new Error(`Benchmark regression detected: ${summary.regressions.join("; ")}`);
      }
    }

    return summary;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function walkMetrics(summary: BenchmarkScenarioRunSummary): Array<{ path: string; metric: BenchmarkScenarioSummary }> {
  const out: Array<{ path: string; metric: BenchmarkScenarioSummary }> = [];
  for (const section of ["retrieval", "write", "stats"] as const) {
    const value = summary[section];
    if (!value) continue;
    for (const [name, metric] of Object.entries(value)) {
      out.push({ path: `${section}.${name}`, metric });
    }
  }
  return out;
}

export async function compareBenchmarkBaseline(
  current: BenchmarkScenarioRunSummary,
  baselineFile: string,
): Promise<string[]> {
  const raw = await readFile(baselineFile, "utf8");
  const baseline = JSON.parse(raw) as BenchmarkScenarioRunSummary;
  const baselineMetrics = new Map(walkMetrics(baseline).map((item) => [item.path, item.metric]));
  const regressions: string[] = [];

  for (const { path, metric } of walkMetrics(current)) {
    const base = baselineMetrics.get(path);
    if (!base || base.p95Ms <= 0) continue;
    const allowed = Math.max(base.p95Ms * 1.25, base.p95Ms + 5);
    if (metric.p95Ms > allowed) {
      regressions.push(`${path}.p95Ms ${metric.p95Ms}ms > ${Math.round(allowed * 10) / 10}ms baseline threshold`);
    }
  }
  return regressions;
}

function parseArgs(argv: string[]): BenchmarkRunOptions {
  const options: BenchmarkRunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--retrieval" && next) {
      options.retrievalFile = next;
      i++;
      continue;
    }
    if (current === "--extraction" && next) {
      options.extractionFile = next;
      i++;
      continue;
    }
    if (current === "--limit" && next) {
      options.limit = Number(next);
      i++;
      continue;
    }
    if (current === "--scenario" && next) {
      options.scenario = next === "retrieval" || next === "write" || next === "stats" || next === "all"
        ? next
        : "all";
      i++;
      continue;
    }
    if (current === "--rows" && next) {
      options.rows = Number(next);
      i++;
      continue;
    }
    if (current === "--iterations" && next) {
      options.iterations = Number(next);
      i++;
      continue;
    }
    if (current === "--baseline" && next) {
      options.baselineFile = next;
      i++;
      continue;
    }
    if (current === "--fail-on-regression") {
      options.failOnRegression = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = options.scenario
    ? await runBenchmarkScenarios(options)
    : await runBenchmarkSummary(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
