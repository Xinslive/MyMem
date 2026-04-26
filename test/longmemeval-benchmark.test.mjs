import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const benchmark = jiti("../benchmark/run.ts");
const { parsePluginConfig } = jiti("../src/plugin-config-parser.ts");

const {
  appendCheckpointRecord,
  attachLongMemEvalProvenance,
  computeRetrievalMetrics,
  ensureDatasetFile,
  extractLongMemEvalProvenances,
  flattenLongMemEvalTurns,
  parseBenchmarkArgs,
  readCheckpointSet,
  resolveBenchmarkLlmConfig,
  runWithConcurrency,
  streamLongMemEvalItems,
  DEFAULT_LLM_CONCURRENCY,
} = benchmark;

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "longmemeval-benchmark-"));
}

function makePluginConfig(overrides = {}) {
  return {
    embedding: {
      apiKey: "embed-key",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "mock-embed",
      dimensions: 4,
    },
    llm: {
      apiKey: "llm-key",
      baseURL: "http://127.0.0.1:2345/v1",
      model: "mock-llm",
    },
    ...overrides,
  };
}

describe("LongMemEval benchmark dataset handling", () => {
  it("skips download when the dataset file already exists", async () => {
    const dir = makeTempDir();
    try {
      const dataPath = path.join(dir, "longmemeval_s_cleaned.json");
      writeFileSync(dataPath, "[]");
      let fetchCalled = false;
      const result = await ensureDatasetFile({
        dataPath,
        allowDownload: false,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("[]");
        },
      });

      assert.equal(result, "exists");
      assert.equal(fetchCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires --download when the dataset file is missing", async () => {
    const dir = makeTempDir();
    try {
      await assert.rejects(
        ensureDatasetFile({
          dataPath: path.join(dir, "missing.json"),
          allowDownload: false,
        }),
        /Re-run with --download/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams LongMemEval root-array items and flattens turn provenance", async () => {
    const dir = makeTempDir();
    try {
      const dataPath = path.join(dir, "fixture.json");
      writeFileSync(dataPath, JSON.stringify([
        {
          question_id: "q1",
          question_type: "single-session-user",
          question: "What degree did I graduate with?",
          answer: "Business Administration",
          answer_session_ids: ["answer_s1"],
          haystack_dates: ["2023/05/20 (Sat) 02:21"],
          haystack_session_ids: ["answer_s1"],
          haystack_sessions: [[
            { role: "user", content: "I graduated with Business Administration.", has_answer: true },
            { role: "assistant", content: "Got it.", has_answer: false },
          ]],
        },
      ]));

      const items = [];
      for await (const item of streamLongMemEvalItems({ dataPath, limit: 1 })) {
        items.push(item);
      }
      assert.equal(items.length, 1);
      assert.equal(items[0].question_id, "q1");

      const turns = flattenLongMemEvalTurns(items[0]);
      assert.equal(turns.length, 2);
      assert.equal(turns[0].key, "q1:answer_s1:0");
      assert.equal(turns[0].provenance.session_date, "2023/05/20 (Sat) 02:21");
      assert.equal(turns[0].provenance.role, "user");
      assert.equal(turns[0].provenance.has_answer, true);
      assert.match(turns[0].text, /^user: I graduated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LongMemEval benchmark resume state", () => {
  it("reads checkpoint keys and ignores malformed checkpoint lines", async () => {
    const dir = makeTempDir();
    try {
      const checkpointPath = path.join(dir, "index.jsonl");
      await appendCheckpointRecord(checkpointPath, { key: "q1:s1:0", question_id: "q1" });
      writeFileSync(checkpointPath, '{"key":"q1:s1:0"}\nnot-json\n{"key":"q2:s2:1"}\n');

      const done = await readCheckpointSet(checkpointPath);
      assert.deepEqual([...done].sort(), ["q1:s1:0", "q2:s2:1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LongMemEval benchmark config validation", () => {
  it("defaults LLM concurrency to 3 and accepts an explicit override", () => {
    assert.equal(DEFAULT_LLM_CONCURRENCY, 3);
    assert.equal(parseBenchmarkArgs([]).llmConcurrency, 3);
    assert.equal(parseBenchmarkArgs(["--llm-concurrency", "5"]).llmConcurrency, 5);
  });

  it("fails fast when llm config is absent", () => {
    const raw = makePluginConfig({ llm: undefined });
    delete raw.llm;
    const parsed = parsePluginConfig(raw);
    assert.throws(
      () => resolveBenchmarkLlmConfig(raw, parsed, "/tmp/openclaw.json"),
      /requires an explicit llm config/,
    );
  });

  it("does not reuse embedding.apiKey as llm.apiKey", () => {
    const raw = makePluginConfig({
      llm: {
        baseURL: "http://127.0.0.1:2345/v1",
        model: "mock-llm",
      },
    });
    const parsed = parsePluginConfig(raw);
    assert.throws(
      () => resolveBenchmarkLlmConfig(raw, parsed, "/tmp/openclaw.json"),
      /requires llm\.apiKey/,
    );
  });
});

describe("LongMemEval benchmark LLM concurrency", () => {
  it("runs workers with no more than the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active--;
    });

    assert.equal(maxActive, 3);
  });
});

describe("LongMemEval benchmark provenance and metrics", () => {
  it("stores explicit provenance and keeps a provenance history", () => {
    const p1 = {
      dataset: "longmemeval_s",
      question_id: "q1",
      question_type: "single-session-user",
      session_id: "s1",
      session_date: "2023/05/20",
      turn_index: 0,
      role: "user",
      has_answer: true,
    };
    const p2 = { ...p1, session_id: "s2", turn_index: 3, has_answer: false };

    const first = attachLongMemEvalProvenance("{}", p1);
    const second = attachLongMemEvalProvenance(first, p2);
    const provenance = extractLongMemEvalProvenances(second);

    assert.equal(provenance.length, 2);
    assert.deepEqual(
      provenance.map((item) => `${item.session_id}:${item.turn_index}`).sort(),
      ["s1:0", "s2:3"],
    );
  });

  it("computes retrieval metrics and skips abstention questions", () => {
    const records = [
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Question 1",
        answer_session_ids: ["s1", "s2"],
        results: [
          { rank: 1, id: "m1", score: 0.9, text: "noise", provenance: [], matched: false },
          {
            rank: 2,
            id: "m2",
            score: 0.8,
            text: "hit",
            matched: true,
            provenance: [{
              dataset: "longmemeval_s",
              question_id: "q1",
              question_type: "single-session-user",
              session_id: "s2",
              session_date: "",
              turn_index: 0,
              role: "user",
              has_answer: true,
            }],
          },
        ],
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Question 2",
        answer_session_ids: ["s4"],
        results: [{
          rank: 1,
          id: "m3",
          score: 0.95,
          text: "hit",
          matched: true,
          provenance: [{
            dataset: "longmemeval_s",
            question_id: "q2",
            question_type: "multi-session",
            session_id: "s4",
            session_date: "",
            turn_index: 0,
            role: "user",
            has_answer: true,
          }],
        }],
      },
      {
        question_id: "q3",
        question_type: "single-session-user_abs",
        question: "Question 3",
        answer_session_ids: ["s9"],
        results: [{
          rank: 1,
          id: "m4",
          score: 0.99,
          text: "abstention hit should not count",
          matched: true,
          provenance: [{
            dataset: "longmemeval_s",
            question_id: "q3",
            question_type: "single-session-user_abs",
            session_id: "s9",
            session_date: "",
            turn_index: 0,
            role: "user",
            has_answer: true,
          }],
        }],
      },
    ];

    const metrics = computeRetrievalMetrics(records, 10);
    assert.equal(metrics.skipped_abstention, 1);
    assert.equal(metrics.overall.questions, 2);
    assert.equal(metrics.overall["hit@10"], 1);
    assert.equal(metrics.overall["recall@10"], 0.75);
    assert.equal(metrics.overall.mrr, 0.75);
    assert.equal(metrics.by_question_type["single-session-user"].questions, 1);
    assert.equal(metrics.by_question_type["multi-session"].questions, 1);
  });
});
