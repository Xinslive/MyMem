import { createReadStream, createWriteStream } from "node:fs";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import JSON5 from "json5";

import { parsePluginConfig } from "../src/plugin-config-parser.js";
import { resolveEnvVars } from "../src/config-utils.js";
import { createEmbedder, getVectorDimensions } from "../src/embedder.js";
import { createLlmClient, type LlmClient } from "../src/llm-client.js";
import {
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalResult,
} from "../src/retriever.js";
import { SmartExtractor } from "../src/smart-extractor.js";
import { MemoryStore, validateStoragePath, type MemoryEntry } from "../src/store.js";

const require = createRequire(import.meta.url);
const streamJsonModule = require("stream-json") as {
  parser: () => NodeJS.ReadWriteStream;
};
const streamArrayModule = require("stream-json/streamers/StreamArray") as {
  streamArray: () => NodeJS.ReadWriteStream;
};

type JsonObject = Record<string, unknown>;
type BenchmarkMode = "download" | "index" | "retrieve" | "qa" | "all";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATA_PATH = join(REPO_ROOT, "benchmark", "data", "longmemeval_s_cleaned.json");
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, "benchmark", "output", "longmemeval_s");
const DEFAULT_DB_PATH = join(REPO_ROOT, "benchmark", ".cache", "longmemeval_s.lancedb");
const DEFAULT_SCOPE = "benchmark:longmemeval_s";
const DEFAULT_LLM_CONCURRENCY = 3;
const LONGMEMEVAL_S_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

export interface BenchmarkCliOptions {
  benchmark: "longmemeval" | "longmemeval_s";
  mode: BenchmarkMode;
  dataPath: string;
  download: boolean;
  topK: number;
  limit?: number;
  questionId?: string;
  configPath?: string;
  dbPath: string;
  outputDir: string;
  fresh: boolean;
  resume: boolean;
  scope: string;
  llmConcurrency: number;
}

export interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  question_date?: string;
  answer?: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: unknown[];
}

export interface LongMemEvalProvenance {
  dataset: "longmemeval_s";
  question_id: string;
  question_type: string;
  session_id: string;
  session_date: string;
  turn_index: number;
  role: string;
  has_answer: boolean;
}

export interface LongMemEvalTurn {
  key: string;
  text: string;
  provenance: LongMemEvalProvenance;
}

export interface RetrievalRecord {
  question_id: string;
  question_type: string;
  question: string;
  answer?: string;
  answer_session_ids: string[];
  results: Array<{
    rank: number;
    id: string;
    score: number;
    text: string;
    provenance: LongMemEvalProvenance[];
    matched: boolean;
  }>;
}

interface BenchmarkRuntime {
  config: ReturnType<typeof parsePluginConfig>;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  llm: LlmClient;
  retriever: ReturnType<typeof createRetriever>;
}

interface CheckpointRecord {
  key: string;
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clampPositiveInt(value: number, fallback: number, max = 1_000_000): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`)) return join(homedir(), value.slice(2));
  return value;
}

function resolveLocalPath(value: string, baseDir = process.cwd()): string {
  const expanded = expandHomePath(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rel(path: string): string {
  const relativePath = relative(process.cwd(), path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

export function parseBenchmarkArgs(argv: string[]): BenchmarkCliOptions {
  const args = argv.filter((arg) => !looksLikeThisScript(arg));
  const opts: BenchmarkCliOptions = {
    benchmark: "longmemeval",
    mode: "all",
    dataPath: DEFAULT_DATA_PATH,
    download: false,
    topK: 10,
    dbPath: DEFAULT_DB_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    fresh: false,
    resume: true,
    scope: DEFAULT_SCOPE,
    llmConcurrency: DEFAULT_LLM_CONCURRENCY,
  };

  const takeValue = (index: number, flag: string): string => {
    const raw = args[index];
    const eq = raw.indexOf("=");
    if (eq !== -1) return raw.slice(eq + 1);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }

    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (flag) {
      case "--benchmark": {
        const value = takeValue(i, flag);
        if (value !== "longmemeval" && value !== "longmemeval_s") {
          throw new Error(`Unsupported benchmark "${value}". This runner currently supports LongMemEval_S only.`);
        }
        opts.benchmark = value;
        if (!arg.includes("=")) i++;
        break;
      }
      case "--mode": {
        const value = takeValue(i, flag);
        if (!["download", "index", "retrieve", "qa", "all"].includes(value)) {
          throw new Error(`Invalid --mode "${value}"`);
        }
        opts.mode = value as BenchmarkMode;
        if (!arg.includes("=")) i++;
        break;
      }
      case "--data":
        opts.dataPath = resolveLocalPath(takeValue(i, flag));
        if (!arg.includes("=")) i++;
        break;
      case "--top-k":
        opts.topK = clampPositiveInt(Number(takeValue(i, flag)), 10, 20);
        if (!arg.includes("=")) i++;
        break;
      case "--limit":
        opts.limit = clampPositiveInt(Number(takeValue(i, flag)), 0);
        if (!arg.includes("=")) i++;
        break;
      case "--question-id":
        opts.questionId = takeValue(i, flag);
        if (!arg.includes("=")) i++;
        break;
      case "--config":
        opts.configPath = resolveLocalPath(takeValue(i, flag));
        if (!arg.includes("=")) i++;
        break;
      case "--db-path":
        opts.dbPath = resolveLocalPath(takeValue(i, flag));
        if (!arg.includes("=")) i++;
        break;
      case "--output-dir":
        opts.outputDir = resolveLocalPath(takeValue(i, flag));
        if (!arg.includes("=")) i++;
        break;
      case "--scope":
        opts.scope = takeValue(i, flag);
        if (!arg.includes("=")) i++;
        break;
      case "--llm-concurrency":
        opts.llmConcurrency = clampPositiveInt(Number(takeValue(i, flag)), DEFAULT_LLM_CONCURRENCY, 16);
        if (!arg.includes("=")) i++;
        break;
      case "--download":
        opts.download = true;
        break;
      case "--fresh":
        opts.fresh = true;
        opts.resume = false;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--no-resume":
        opts.resume = false;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`LongMemEval_S benchmark runner

Usage:
  npm run bench:longmemeval -- --download
  npm run bench:longmemeval -- --mode retrieve --top-k 10

Options:
  --mode download|index|retrieve|qa|all
  --download                 Allow downloading longmemeval_s_cleaned.json if missing
  --data <path>              Dataset path (default: benchmark/data/longmemeval_s_cleaned.json)
  --top-k <n>                Retrieval cutoff, max 20 (default: 10)
  --limit <n>                Limit question count after filtering
  --question-id <id>         Run one question
  --config <path>            OpenClaw config path
  --db-path <path>           Local LanceDB path (default: benchmark/.cache/longmemeval_s.lancedb)
  --output-dir <path>        Output directory (default: benchmark/output/longmemeval_s)
  --llm-concurrency <n>      Concurrent LLM turn/QA calls, max 16 (default: 3)
  --fresh                    Remove output/db before running
  --resume                   Skip completed checkpoint records (default)
`);
}

export async function ensureDatasetFile(params: {
  dataPath: string;
  allowDownload: boolean;
  url?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<"exists" | "downloaded"> {
  const dataPath = resolveLocalPath(params.dataPath);
  if (await pathExists(dataPath)) {
    params.log?.(`dataset already present: ${rel(dataPath)}`);
    return "exists";
  }

  if (!params.allowDownload) {
    throw new Error(
      `LongMemEval_S data file not found at ${dataPath}. Re-run with --download to fetch longmemeval_s_cleaned.json on demand.`,
    );
  }

  await mkdir(dirname(dataPath), { recursive: true });
  const url = params.url ?? LONGMEMEVAL_S_URL;
  const fetchImpl = params.fetchImpl ?? fetch;
  params.log?.(`downloading LongMemEval_S from ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download LongMemEval_S: HTTP ${response.status} ${response.statusText}`);
  }

  const tmpPath = `${dataPath}.tmp-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tmpPath));
    await rename(tmpPath, dataPath);
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }
  params.log?.(`downloaded LongMemEval_S to ${rel(dataPath)}`);
  return "downloaded";
}

export function normalizeLongMemEvalItem(value: unknown): LongMemEvalItem | null {
  const raw = asObject(value);
  if (!raw) return null;
  const questionId = asString(raw.question_id);
  const questionType = asString(raw.question_type);
  const question = asString(raw.question);
  if (!questionId || !questionType || !question) return null;

  const sessions = Array.isArray(raw.haystack_sessions) ? raw.haystack_sessions : [];
  return {
    question_id: questionId,
    question_type: questionType,
    question,
    question_date: asString(raw.question_date),
    answer: asString(raw.answer),
    answer_session_ids: asStringArray(raw.answer_session_ids),
    haystack_dates: asStringArray(raw.haystack_dates),
    haystack_session_ids: asStringArray(raw.haystack_session_ids),
    haystack_sessions: sessions,
  };
}

export async function* streamLongMemEvalItems(params: {
  dataPath: string;
  limit?: number;
  questionId?: string;
}): AsyncGenerator<LongMemEvalItem> {
  const source = createReadStream(params.dataPath, { encoding: "utf8" });
  const parser = streamJsonModule.parser();
  const stream = source.pipe(parser).pipe(streamArrayModule.streamArray());
  let yielded = 0;

  try {
    for await (const chunk of stream as AsyncIterable<{ key: number; value: unknown }>) {
      const item = normalizeLongMemEvalItem(chunk.value);
      if (!item) continue;
      if (params.questionId && item.question_id !== params.questionId) continue;
      yield item;
      yielded++;
      if (params.limit && yielded >= params.limit) break;
    }
  } finally {
    source.destroy();
    (parser as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
    (stream as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
  }
}

export function flattenLongMemEvalTurns(item: LongMemEvalItem): LongMemEvalTurn[] {
  const turns: LongMemEvalTurn[] = [];
  for (let sessionIndex = 0; sessionIndex < item.haystack_sessions.length; sessionIndex++) {
    const rawSession = item.haystack_sessions[sessionIndex];
    const messages = Array.isArray(rawSession)
      ? rawSession
      : Array.isArray(asObject(rawSession)?.messages)
        ? (asObject(rawSession)?.messages as unknown[])
        : [];
    const sessionId = item.haystack_session_ids[sessionIndex] ?? `session_${sessionIndex}`;
    const sessionDate = item.haystack_dates[sessionIndex] ?? "";

    for (let turnIndex = 0; turnIndex < messages.length; turnIndex++) {
      const message = asObject(messages[turnIndex]);
      if (!message) continue;
      const content = asString(message.content);
      if (!content) continue;
      const role = asString(message.role) ?? "unknown";
      const hasAnswer = message.has_answer === true;
      const provenance: LongMemEvalProvenance = {
        dataset: "longmemeval_s",
        question_id: item.question_id,
        question_type: item.question_type,
        session_id: sessionId,
        session_date: sessionDate,
        turn_index: turnIndex,
        role,
        has_answer: hasAnswer,
      };
      turns.push({
        key: `${item.question_id}:${sessionId}:${turnIndex}`,
        provenance,
        text: `${role}: ${content}`,
      });
    }
  }
  return turns;
}

export function attachLongMemEvalProvenance(
  metadata: string | undefined,
  provenance: LongMemEvalProvenance,
): string {
  let parsed: JsonObject = {};
  if (metadata && metadata.trim()) {
    try {
      parsed = JSON.parse(metadata) as JsonObject;
    } catch {
      parsed = {};
    }
  }

  const previous = extractLongMemEvalProvenances(JSON.stringify(parsed));
  const provenanceKey = (value: LongMemEvalProvenance) =>
    `${value.question_id}:${value.session_id}:${value.turn_index}:${value.role}`;
  const seen = new Set(previous.map(provenanceKey));
  if (!seen.has(provenanceKey(provenance))) previous.push(provenance);

  parsed.longmemeval = provenance;
  parsed.longmemeval_provenance = previous;
  return JSON.stringify(parsed);
}

export function extractLongMemEvalProvenances(metadata: string | undefined): LongMemEvalProvenance[] {
  if (!metadata) return [];
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(metadata) as JsonObject;
  } catch {
    return [];
  }

  const results: LongMemEvalProvenance[] = [];
  const pushIfValid = (value: unknown) => {
    const raw = asObject(value);
    if (!raw) return;
    const questionId = asString(raw.question_id);
    const questionType = asString(raw.question_type);
    const sessionId = asString(raw.session_id);
    const role = asString(raw.role);
    if (!questionId || !questionType || !sessionId || !role) return;
    results.push({
      dataset: "longmemeval_s",
      question_id: questionId,
      question_type: questionType,
      session_id: sessionId,
      session_date: asString(raw.session_date) ?? "",
      turn_index: typeof raw.turn_index === "number" ? raw.turn_index : 0,
      role,
      has_answer: raw.has_answer === true,
    });
  };

  pushIfValid(parsed.longmemeval);
  if (Array.isArray(parsed.longmemeval_provenance)) {
    for (const value of parsed.longmemeval_provenance) pushIfValid(value);
  }

  const unique = new Map<string, LongMemEvalProvenance>();
  for (const value of results) {
    unique.set(`${value.question_id}:${value.session_id}:${value.turn_index}:${value.role}`, value);
  }
  return [...unique.values()];
}

function createProvenanceStore(store: MemoryStore, provenance: LongMemEvalProvenance): MemoryStore {
  let batchActive = false;
  let batchBuffer: MemoryEntry[] = [];

  return new Proxy(store as any, {
    get(target, prop, receiver) {
      if (prop === "startBatch") {
        return () => {
          batchActive = true;
          batchBuffer = [];
        };
      }
      if (prop === "flushBatch") {
        return async () => {
          batchActive = false;
          const entries = batchBuffer;
          batchBuffer = [];
          const stored: MemoryEntry[] = [];
          for (const entry of entries) {
            stored.push(await target.importEntry(entry));
          }
          return stored;
        };
      }
      if (prop === "store") {
        return async (entry: Omit<MemoryEntry, "id" | "timestamp">) => {
          const fullEntry: MemoryEntry = {
            ...entry,
            id: randomUUID(),
            timestamp: Date.now(),
            metadata: attachLongMemEvalProvenance(entry.metadata, provenance),
          };
          if (batchActive) {
            batchBuffer.push(fullEntry);
            return fullEntry;
          }
          return target.importEntry(fullEntry);
        };
      }
      if (prop === "update") {
        return async (id: string, updates: Record<string, unknown>, scopeFilter?: string[]) => {
          const patched = { ...updates };
          if (typeof patched.metadata === "string") {
            patched.metadata = attachLongMemEvalProvenance(patched.metadata, provenance);
          }
          return target.update(id, patched, scopeFilter);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryStore;
}

export async function readCheckpointSet(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!(await pathExists(path))) return done;
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as CheckpointRecord;
      if (typeof record.key === "string" && record.key.length > 0) {
        done.add(record.key);
      }
    } catch {
      // Ignore malformed checkpoint lines; a later resume can rewrite them.
    }
  }
  return done;
}

export async function appendCheckpointRecord(path: string, record: CheckpointRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function runWithConcurrency<T>(
  items: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = clampPositiveInt(concurrency, DEFAULT_LLM_CONCURRENCY, 16);
  const inFlight = new Set<Promise<void>>();

  const launch = (item: T) => {
    const promise = Promise.resolve()
      .then(() => worker(item))
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  };

  try {
    for await (const item of items) {
      while (inFlight.size >= limit) {
        await Promise.race(inFlight);
      }
      launch(item);
    }
    await Promise.all(inFlight);
  } catch (error) {
    await Promise.allSettled(inFlight);
    throw error;
  }
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!(await pathExists(path))) return [];
  const rows: T[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as T);
  }
  return rows;
}

export function resolveOpenClawConfigPath(explicitPath?: string): string {
  if (explicitPath) return resolveLocalPath(explicitPath);
  if (process.env.OPENCLAW_CONFIG_PATH) return resolveLocalPath(process.env.OPENCLAW_CONFIG_PATH);
  return join(homedir(), ".openclaw", "openclaw.json");
}

export function extractMemoryPluginConfig(config: unknown): JsonObject {
  const root = asObject(config);
  if (!root) throw new Error("OpenClaw config must be a JSON object");
  if (asObject(root.embedding)) return root;

  const plugins = asObject(root.plugins);
  const entries = asObject(plugins?.entries);
  const entry = asObject(entries?.["mymem"]);
  const nestedConfig = asObject(entry?.config);
  if (nestedConfig) return nestedConfig;

  const direct = asObject(root["mymem"]);
  const directConfig = asObject(direct?.config) ?? direct;
  if (directConfig && asObject(directConfig.embedding)) return directConfig;

  throw new Error(
    "Could not find mymem config. Expected plugins.entries[\"mymem\"].config or a direct plugin config object.",
  );
}

export async function loadBenchmarkPluginConfig(configPath?: string): Promise<{
  path: string;
  rawPluginConfig: JsonObject;
}> {
  const path = resolveOpenClawConfigPath(configPath);
  const body = await readFile(path, "utf8");
  const parsed = JSON5.parse(body) as unknown;
  return {
    path,
    rawPluginConfig: extractMemoryPluginConfig(parsed),
  };
}

export function resolveBenchmarkLlmConfig(
  rawPluginConfig: JsonObject,
  parsedConfig: ReturnType<typeof parsePluginConfig>,
  configPath: string,
): Parameters<typeof createLlmClient>[0] {
  const rawLlm = asObject(rawPluginConfig.llm);
  if (!rawLlm) {
    throw new Error(
      "LongMemEval benchmark requires an explicit llm config. Add mymem.config.llm with baseURL, apiKey, and model; the benchmark does not fall back to pure vector indexing.",
    );
  }

  const auth = rawLlm.auth === "oauth" ? "oauth" : "api-key";
  const model = asString(parsedConfig.llm?.model);
  if (!model) {
    throw new Error("LongMemEval benchmark requires llm.model.");
  }

  const timeoutMs =
    typeof parsedConfig.llm?.timeoutMs === "number" ? parsedConfig.llm.timeoutMs : 90_000;

  if (auth === "oauth") {
    const oauthPath =
      asString(rawLlm.oauthPath)
        ? resolveLocalPath(resolveEnvVars(asString(rawLlm.oauthPath)!), dirname(configPath))
        : join(homedir(), ".openclaw", ".mymem", "oauth.json");
    return {
      auth,
      model,
      baseURL: asString(parsedConfig.llm?.baseURL),
      oauthPath,
      oauthProvider: asString(rawLlm.oauthProvider),
      timeoutMs,
      warnLog: (msg: string) => console.warn(msg),
    };
  }

  const apiKey = asString(rawLlm.apiKey);
  const baseURL = asString(parsedConfig.llm?.baseURL);
  if (!apiKey) {
    throw new Error(
      "LongMemEval benchmark requires llm.apiKey for api-key auth. It intentionally does not reuse embedding.apiKey.",
    );
  }
  if (!baseURL) {
    throw new Error("LongMemEval benchmark requires llm.baseURL for api-key auth.");
  }

  return {
    auth,
    apiKey: resolveEnvVars(apiKey),
    model,
    baseURL,
    timeoutMs,
    warnLog: (msg: string) => console.warn(msg),
  };
}

async function createRuntime(opts: BenchmarkCliOptions): Promise<BenchmarkRuntime> {
  const loaded = await loadBenchmarkPluginConfig(opts.configPath);
  const config = parsePluginConfig(loaded.rawPluginConfig);
  const llmConfig = resolveBenchmarkLlmConfig(loaded.rawPluginConfig, config, loaded.path);

  const embeddingModel = config.embedding.model || "text-embedding-3-small";
  const vectorDim = getVectorDimensions(embeddingModel, config.embedding.dimensions);
  await mkdir(opts.dbPath, { recursive: true });
  validateStoragePath(opts.dbPath);

  const store = new MemoryStore({ dbPath: opts.dbPath, vectorDim });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: config.embedding.apiKey,
    model: embeddingModel,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    omitDimensions: config.embedding.omitDimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
  });
  const llm = createLlmClient(llmConfig);
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval ?? {}),
    candidatePoolSize: Math.max(opts.topK * 4, config.retrieval?.candidatePoolSize ?? DEFAULT_RETRIEVAL_CONFIG.candidatePoolSize),
  });

  return { config, store, embedder, llm, retriever };
}

function checkpointPath(opts: BenchmarkCliOptions, name: string): string {
  return join(opts.outputDir, "checkpoints", `${name}.jsonl`);
}

async function prepareFreshRun(opts: BenchmarkCliOptions): Promise<void> {
  if (!opts.fresh) return;
  await rm(opts.outputDir, { recursive: true, force: true });
  await rm(opts.dbPath, { recursive: true, force: true });
}

async function prepareStageFiles(opts: BenchmarkCliOptions, mode: "index" | "retrieve" | "qa"): Promise<void> {
  await mkdir(opts.outputDir, { recursive: true });
  if (opts.resume) return;
  await unlinkIfExists(checkpointPath(opts, mode));
  if (mode === "retrieve") {
    await unlinkIfExists(join(opts.outputDir, "retrieval.jsonl"));
    await unlinkIfExists(join(opts.outputDir, "metrics.json"));
  }
  if (mode === "qa") {
    await unlinkIfExists(join(opts.outputDir, "hypotheses.jsonl"));
  }
}

export async function runIndexStage(opts: BenchmarkCliOptions, runtime: BenchmarkRuntime): Promise<void> {
  await prepareStageFiles(opts, "index");
  const checkpoint = checkpointPath(opts, "index");
  const done = opts.resume ? await readCheckpointSet(checkpoint) : new Set<string>();
  let indexedTurns = 0;
  let skippedTurns = 0;

  async function* pendingTurns(): AsyncGenerator<LongMemEvalTurn> {
    for await (const item of streamLongMemEvalItems({
      dataPath: opts.dataPath,
      limit: opts.limit,
      questionId: opts.questionId,
    })) {
      for (const turn of flattenLongMemEvalTurns(item)) {
        if (done.has(turn.key)) {
          skippedTurns++;
          continue;
        }
        yield turn;
      }
    }
  }

  await runWithConcurrency(pendingTurns(), opts.llmConcurrency, async (turn) => {
    const extractor = new SmartExtractor(
      createProvenanceStore(runtime.store, turn.provenance),
      runtime.embedder,
      runtime.llm,
      {
        user: "User",
        extractMinMessages: 1,
        extractMaxChars: runtime.config.extractMaxChars ?? 8000,
        defaultScope: opts.scope,
        log: (msg: string) => console.log(msg),
        debugLog: () => {},
      },
    );

    await extractor.extractAndPersist(turn.text, turn.key, {
      scope: opts.scope,
      scopeFilter: [opts.scope],
    });
    await appendCheckpointRecord(checkpoint, {
      key: turn.key,
      question_id: turn.provenance.question_id,
      session_id: turn.provenance.session_id,
      turn_index: turn.provenance.turn_index,
    });
    indexedTurns++;
  });

  console.log(`index stage complete: indexed=${indexedTurns}, skipped=${skippedTurns}`);
}

function serializeRetrievalResult(result: RetrievalResult, rank: number, answerSessionIds: Set<string>) {
  const provenance = extractLongMemEvalProvenances(result.entry.metadata);
  return {
    rank,
    id: result.entry.id,
    score: result.score,
    text: result.entry.text,
    provenance,
    matched: provenance.some((item) => answerSessionIds.has(item.session_id)),
  };
}

export async function runRetrieveStage(opts: BenchmarkCliOptions, runtime: BenchmarkRuntime): Promise<void> {
  await prepareStageFiles(opts, "retrieve");
  const checkpoint = checkpointPath(opts, "retrieve");
  const output = join(opts.outputDir, "retrieval.jsonl");
  const done = opts.resume ? await readCheckpointSet(checkpoint) : new Set<string>();
  let retrieved = 0;
  let skipped = 0;

  for await (const item of streamLongMemEvalItems({
    dataPath: opts.dataPath,
    limit: opts.limit,
    questionId: opts.questionId,
  })) {
    if (done.has(item.question_id)) {
      skipped++;
      continue;
    }
    const answerSessionIds = new Set(item.answer_session_ids);
    const results = await runtime.retriever.retrieve({
      query: item.question,
      limit: opts.topK,
      scopeFilter: [opts.scope],
      source: "cli",
      candidatePoolSize: Math.max(opts.topK * 4, DEFAULT_RETRIEVAL_CONFIG.candidatePoolSize),
      overFetchMultiplier: 20,
    });
    const record: RetrievalRecord = {
      question_id: item.question_id,
      question_type: item.question_type,
      question: item.question,
      answer: item.answer,
      answer_session_ids: item.answer_session_ids,
      results: results.map((result, index) =>
        serializeRetrievalResult(result, index + 1, answerSessionIds),
      ),
    };
    await appendJsonl(output, record);
    await appendCheckpointRecord(checkpoint, { key: item.question_id });
    retrieved++;
  }

  const records = await readJsonl<RetrievalRecord>(output);
  const metrics = computeRetrievalMetrics(records, opts.topK);
  await writeFile(join(opts.outputDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  console.log(`retrieve stage complete: retrieved=${retrieved}, skipped=${skipped}`);
}

interface MetricBucket {
  count: number;
  hitSum: number;
  recallSum: number;
  reciprocalRankSum: number;
}

function emptyBucket(): MetricBucket {
  return { count: 0, hitSum: 0, recallSum: 0, reciprocalRankSum: 0 };
}

function bucketToJson(bucket: MetricBucket, k: number): JsonObject {
  return {
    questions: bucket.count,
    [`hit@${k}`]: bucket.count > 0 ? bucket.hitSum / bucket.count : 0,
    [`recall@${k}`]: bucket.count > 0 ? bucket.recallSum / bucket.count : 0,
    mrr: bucket.count > 0 ? bucket.reciprocalRankSum / bucket.count : 0,
  };
}

export function computeRetrievalMetrics(records: RetrievalRecord[], topK: number): JsonObject {
  const overall = emptyBucket();
  const byType = new Map<string, MetricBucket>();
  let skippedAbstention = 0;

  for (const record of records) {
    if (record.question_type.endsWith("_abs") || record.answer_session_ids.length === 0) {
      skippedAbstention++;
      continue;
    }

    const answerSessionIds = new Set(record.answer_session_ids);
    const matchedSessions = new Set<string>();
    let firstHitRank = 0;
    for (const result of record.results.slice(0, topK)) {
      const matched = result.provenance.filter((item) => answerSessionIds.has(item.session_id));
      if (matched.length === 0) continue;
      if (firstHitRank === 0) firstHitRank = result.rank;
      for (const item of matched) matchedSessions.add(item.session_id);
    }

    const hit = firstHitRank > 0 ? 1 : 0;
    const recall = answerSessionIds.size > 0 ? matchedSessions.size / answerSessionIds.size : 0;
    const rr = firstHitRank > 0 ? 1 / firstHitRank : 0;
    for (const bucket of [overall, byType.get(record.question_type) ?? emptyBucket()]) {
      bucket.count++;
      bucket.hitSum += hit;
      bucket.recallSum += recall;
      bucket.reciprocalRankSum += rr;
      if (!byType.has(record.question_type) && bucket !== overall) {
        byType.set(record.question_type, bucket);
      }
    }
  }

  const byQuestionType: JsonObject = {};
  for (const [type, bucket] of byType) {
    byQuestionType[type] = bucketToJson(bucket, topK);
  }

  return {
    dataset: "longmemeval_s",
    k: topK,
    skipped_abstention: skippedAbstention,
    overall: bucketToJson(overall, topK),
    by_question_type: byQuestionType,
  };
}

function buildQaPrompt(record: RetrievalRecord): string {
  const memories = record.results
    .map((result) => `[${result.rank}] ${result.text}`)
    .join("\n");
  return [
    "Answer the question using only the retrieved memories.",
    "If the answer is not present, answer \"I don't know\".",
    "Return JSON with exactly one field: {\"answer\":\"...\"}.",
    "",
    `Question: ${record.question}`,
    "",
    "Retrieved memories:",
    memories || "(none)",
  ].join("\n");
}

export async function runQaStage(opts: BenchmarkCliOptions, runtime: BenchmarkRuntime): Promise<void> {
  await prepareStageFiles(opts, "qa");
  const retrievalPath = join(opts.outputDir, "retrieval.jsonl");
  const outputPath = join(opts.outputDir, "hypotheses.jsonl");
  const checkpoint = checkpointPath(opts, "qa");
  const done = opts.resume ? await readCheckpointSet(checkpoint) : new Set<string>();
  const records = await readJsonl<RetrievalRecord>(retrievalPath);
  if (records.length === 0) {
    throw new Error(`No retrieval records found at ${retrievalPath}. Run --mode retrieve first.`);
  }

  let answered = 0;
  let skipped = 0;
  await runWithConcurrency(records, opts.llmConcurrency, async (record) => {
    if (done.has(record.question_id)) {
      skipped++;
      return;
    }
    const response = await runtime.llm.completeJson<{ answer?: string; hypothesis?: string }>(
      buildQaPrompt(record),
      "longmemeval-qa",
    );
    const hypothesis = asString(response?.answer) ?? asString(response?.hypothesis) ?? "";
    await appendJsonl(outputPath, {
      question_id: record.question_id,
      hypothesis,
    });
    await appendCheckpointRecord(checkpoint, { key: record.question_id });
    answered++;
  });
  console.log(`qa stage complete: answered=${answered}, skipped=${skipped}`);
}

export async function runBenchmark(opts: BenchmarkCliOptions): Promise<void> {
  if (opts.benchmark !== "longmemeval" && opts.benchmark !== "longmemeval_s") {
    throw new Error(`Unsupported benchmark "${opts.benchmark}"`);
  }

  await prepareFreshRun(opts);
  if (opts.mode === "download" || opts.mode === "all") {
    await ensureDatasetFile({
      dataPath: opts.dataPath,
      allowDownload: opts.download,
      log: (msg) => console.log(msg),
    });
    if (opts.mode === "download") return;
  } else {
    await ensureDatasetFile({ dataPath: opts.dataPath, allowDownload: false });
  }

  const runtime = await createRuntime(opts);
  if (opts.mode === "index" || opts.mode === "all") {
    await runIndexStage(opts, runtime);
  }
  if (opts.mode === "retrieve" || opts.mode === "all") {
    await runRetrieveStage(opts, runtime);
  }
  if (opts.mode === "qa" || opts.mode === "all") {
    await runQaStage(opts, runtime);
  }
}

function looksLikeThisScript(arg: string): boolean {
  if (!arg) return false;
  const thisPath = fileURLToPath(import.meta.url);
  try {
    return resolveLocalPath(arg) === thisPath;
  } catch {
    return arg.endsWith("benchmark/run.ts");
  }
}

async function main(argv: string[]): Promise<void> {
  const opts = parseBenchmarkArgs(argv);
  await runBenchmark(opts);
}

if (process.argv.some((arg) => looksLikeThisScript(arg))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  DEFAULT_DATA_PATH,
  DEFAULT_DB_PATH,
  DEFAULT_LLM_CONCURRENCY,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_SCOPE,
  LONGMEMEVAL_S_URL,
};
