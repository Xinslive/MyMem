import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { runRecallEval } = jiti("../benchmark/recall-eval.ts");

describe("recall eval harness", () => {
  it("passes fixed synthetic recall quality gates", async () => {
    const summary = await runRecallEval();

    assert.equal(summary.failedCases, 0, JSON.stringify(summary, null, 2));
    assert.equal(summary.passedCases, summary.totalCases);
    assert.ok(summary.totalCases >= 6);

    const byName = new Map(summary.cases.map((item) => [item.name, item]));
    assert.deepEqual(
      byName.get("Scope isolation blocks inaccessible scope")?.actualIds.includes("eval_scope_private"),
      false,
    );
    assert.deepEqual(
      byName.get("Expired and archived records do not survive")?.actualIds.some((id) =>
        id === "eval_expired_trip" || id === "eval_archived_fragment"
      ),
      false,
    );
  });
});
