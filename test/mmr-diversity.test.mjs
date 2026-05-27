import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { applyMMRDiversity } = jiti("../src/mmr-diversity.ts");

function result(id, vector, score) {
  return {
    entry: {
      id,
      text: id,
      vector,
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    },
    score,
  };
}

describe("applyMMRDiversity", () => {
  it("defers near-duplicate vectors behind diverse results", () => {
    const output = applyMMRDiversity([
      result("primary", [1, 0], 0.9),
      result("near-duplicate", [0.99, 0.01], 0.8),
      result("diverse", [0, 1], 0.7),
    ]);

    assert.deepEqual(
      output.map((item) => item.entry.id),
      ["primary", "diverse", "near-duplicate"],
    );
  });

  it("keeps original order when vectors are below the similarity threshold", () => {
    const output = applyMMRDiversity([
      result("first", [1, 0], 0.9),
      result("second", [0.5, 0.866], 0.8),
      result("third", [0, 1], 0.7),
    ]);

    assert.deepEqual(
      output.map((item) => item.entry.id),
      ["first", "second", "third"],
    );
  });
});
