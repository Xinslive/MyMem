import { pathToFileURL } from "node:url";
import {
  buildExtractionSummary,
  buildRetrievalSummary,
  readJsonlRecords,
  type ExtractionTelemetryRecord,
  type RetrievalTelemetryRecord,
} from "../src/telemetry.js";

export interface BenchmarkRunOptions {
  retrievalFile?: string;
  extractionFile?: string;
  limit?: number;
}

export interface BenchmarkRunSummary {
  retrieval: ReturnType<typeof buildRetrievalSummary> | null;
  extraction: ReturnType<typeof buildExtractionSummary> | null;
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
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runBenchmarkSummary(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
