import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryStore, type MemoryEntry } from "../src/store.js";
import { createRetriever, type RetrievalResult } from "../src/retriever.js";
import { buildSmartMetadata, stringifySmartMetadata } from "../src/smart-metadata.js";
import type { MemoryCategory } from "../src/memory-categories.js";

export interface RecallEvalOptions {
  rowsDir?: string;
}

export interface RecallEvalCaseResult {
  name: string;
  query: string;
  expectedIds: string[];
  forbiddenIds: string[];
  actualIds: string[];
  actualScopes: string[];
  passed: boolean;
  zeroResult: boolean;
  failureReason?: string;
}

export interface RecallEvalSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  zeroResultCases: number;
  cases: RecallEvalCaseResult[];
}

type EvalCase = {
  name: string;
  query: string;
  limit?: number;
  scopeFilter?: string[];
  category?: MemoryEntry["category"];
  source?: "manual" | "auto-recall" | "cli";
  candidatePoolSize?: number;
  expectedIds?: string[];
  forbiddenIds?: string[];
};

const VECTOR_DIMENSIONS = 8;

function deterministicVector(text: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % dimensions] += ((text.charCodeAt(i) % 23) - 11) / 11;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function metadata(text: string, category: MemoryEntry["category"], memoryCategory: MemoryCategory, patch: Record<string, unknown> = {}): string {
  return stringifySmartMetadata(
    buildSmartMetadata(
      { text, category, importance: 0.8, timestamp: Date.now() },
      {
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        memory_category: memoryCategory,
        source: "manual",
        state: "confirmed",
        memory_layer: "working",
        ...patch,
      },
    ),
  );
}

function entry(params: {
  id: string;
  text: string;
  category: MemoryEntry["category"];
  scope: string;
  importance?: number;
  memoryCategory: MemoryCategory;
  metadataPatch?: Record<string, unknown>;
}): MemoryEntry {
  return {
    id: params.id,
    text: params.text,
    vector: deterministicVector(params.text),
    category: params.category,
    scope: params.scope,
    importance: params.importance ?? 0.8,
    timestamp: Date.now(),
    metadata: metadata(params.text, params.category, params.memoryCategory, params.metadataPatch),
  };
}

function evalEntries(): MemoryEntry[] {
  const now = Date.now();
  return [
    entry({
      id: "eval_pref_oolong",
      text: "用户的饮料偏好是热乌龙茶，不喜欢冰美式咖啡。",
      category: "preference",
      scope: "global",
      importance: 0.95,
      memoryCategory: "preferences",
    }),
    entry({
      id: "eval_profile_english",
      text: "The user prefers concise answers with the conclusion first.",
      category: "fact",
      scope: "global",
      importance: 0.9,
      memoryCategory: "profile",
    }),
    entry({
      id: "eval_tag_bench",
      text: "proj:bench team:core deployment latency budget is 20 seconds.",
      category: "decision",
      scope: "agent:main",
      importance: 0.85,
      memoryCategory: "events",
    }),
    entry({
      id: "eval_scope_private",
      text: "agent private planning note for smoke-only workspace.",
      category: "fact",
      scope: "agent:smoke",
      importance: 0.8,
      memoryCategory: "cases",
    }),
    entry({
      id: "eval_expired_trip",
      text: "The old trip reminder expired yesterday.",
      category: "decision",
      scope: "global",
      importance: 0.8,
      memoryCategory: "events",
      metadataPatch: { valid_until: now - 60_000 },
    }),
    entry({
      id: "eval_archived_fragment",
      text: "Archived duplicate fragment about the deployment latency budget.",
      category: "decision",
      scope: "global",
      importance: 0.8,
      memoryCategory: "events",
      metadataPatch: { valid_from: now - 120_000, invalidated_at: now - 60_000, state: "archived", memory_layer: "archive" },
    }),
    entry({
      id: "eval_low_score_noise",
      text: "unrelated gardening compost note with no retrieval overlap",
      category: "other",
      scope: "global",
      importance: 0.2,
      memoryCategory: "patterns",
    }),
  ];
}

const EVAL_CASES: EvalCase[] = [
  {
    name: "Chinese preference recall",
    query: "我喜欢喝什么茶",
    scopeFilter: ["global"],
    expectedIds: ["eval_pref_oolong"],
  },
  {
    name: "English profile recall",
    query: "how should answers be structured",
    scopeFilter: ["global"],
    expectedIds: ["eval_profile_english"],
  },
  {
    name: "Tag query uses exact token path",
    query: "proj:bench",
    scopeFilter: ["agent:main", "global"],
    expectedIds: ["eval_tag_bench"],
  },
  {
    name: "Scope isolation blocks inaccessible scope",
    query: "smoke-only workspace private planning",
    scopeFilter: ["global"],
    expectedIds: [],
    forbiddenIds: ["eval_scope_private"],
  },
  {
    name: "Expired and archived records do not survive",
    query: "old trip reminder expired deployment duplicate fragment",
    scopeFilter: ["global"],
    expectedIds: [],
    forbiddenIds: ["eval_expired_trip", "eval_archived_fragment"],
  },
  {
    name: "Auto-recall candidate pool still finds relevant memory",
    query: "deployment latency budget",
    scopeFilter: ["agent:main", "global"],
    source: "auto-recall",
    candidatePoolSize: 6,
    expectedIds: ["eval_tag_bench"],
    forbiddenIds: ["eval_archived_fragment"],
  },
];

function caseFailure(testCase: EvalCase, results: RetrievalResult[]): string | undefined {
  const actualIds = results.map((result) => result.entry.id);
  const expectedIds = testCase.expectedIds ?? [];
  const forbiddenIds = testCase.forbiddenIds ?? [];
  const hasExpected = expectedIds.length === 0 || expectedIds.some((id) => actualIds.includes(id));
  if (!hasExpected) {
    return `Expected one of [${expectedIds.join(", ")}], got [${actualIds.join(", ")}]`;
  }
  const forbiddenHit = forbiddenIds.find((id) => actualIds.includes(id));
  if (forbiddenHit) {
    return `Forbidden memory ${forbiddenHit} was returned`;
  }
  if (expectedIds.length > 0 && actualIds.length === 0) {
    return "Expected a result but retrieval returned zero results";
  }
  return undefined;
}

export async function runRecallEval(options: RecallEvalOptions = {}): Promise<RecallEvalSummary> {
  const tempDir = options.rowsDir ?? await mkdtemp(join(tmpdir(), "mymem-recall-eval-"));
  const shouldCleanup = !options.rowsDir;
  try {
    const store = new MemoryStore({ dbPath: tempDir, vectorDim: VECTOR_DIMENSIONS });
    for (const memory of evalEntries()) {
      await store.importEntry(memory);
    }
    const retriever = createRetriever(
      store,
      {
        dimensions: VECTOR_DIMENSIONS,
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
        minScore: 0.08,
        hardMinScore: 0.08,
        filterNoise: false,
        candidatePoolSize: 12,
        queryExpansion: false,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
      },
    );

    const cases: RecallEvalCaseResult[] = [];
    for (const testCase of EVAL_CASES) {
      const results = await retriever.retrieve({
        query: testCase.query,
        limit: testCase.limit ?? 5,
        scopeFilter: testCase.scopeFilter,
        category: testCase.category,
        source: testCase.source ?? "manual",
        candidatePoolSize: testCase.candidatePoolSize,
      });
      const failureReason = caseFailure(testCase, results);
      cases.push({
        name: testCase.name,
        query: testCase.query,
        expectedIds: testCase.expectedIds ?? [],
        forbiddenIds: testCase.forbiddenIds ?? [],
        actualIds: results.map((result) => result.entry.id),
        actualScopes: [...new Set(results.map((result) => result.entry.scope))],
        passed: failureReason === undefined,
        zeroResult: results.length === 0,
        failureReason,
      });
    }

    return {
      totalCases: cases.length,
      passedCases: cases.filter((item) => item.passed).length,
      failedCases: cases.filter((item) => !item.passed).length,
      zeroResultCases: cases.filter((item) => item.zeroResult).length,
      cases,
    };
  } finally {
    if (shouldCleanup) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const summary = await runRecallEval();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failedCases > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
