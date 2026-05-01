import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { fuseResults } = jiti("../src/rrf-fusion.ts");

function buildSearchResult(id, score = 0.9) {
  return {
    entry: {
      id,
      text: `memory ${id}`,
      vector: [0.1, 0.2, 0.3],
      category: "other",
      scope: "global",
      importance: 0.7,
      timestamp: 1700000000000,
      metadata: "{}",
    },
    score,
  };
}

describe("RRF fusion", () => {
  it("treats hasIds as an optional store capability", async () => {
    const debugLogs = [];

    const results = await fuseResults(
      [],
      [{ ...buildSearchResult("bm25-only"), rank: 1 }],
      { vectorWeight: 0.6, bm25Weight: 0.4 },
      {},
      {
        debug: (message) => debugLogs.push(message),
        warn: () => {},
      },
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, "bm25-only");
    assert.deepEqual(debugLogs, []);
  });
});
