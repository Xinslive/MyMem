import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveUnlessAborted } = jiti("../src/retriever-utils.ts");

function createAbortHarness() {
  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      if (type === "abort") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "abort") listeners.delete(listener);
    },
  };

  return {
    signal,
    get listenerCount() {
      return listeners.size;
    },
    abort(reason) {
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of [...listeners]) {
        if (typeof listener === "function") listener();
        else listener?.handleEvent?.({ type: "abort" });
      }
    },
  };
}

describe("resolveUnlessAborted", () => {
  it("removes the abort listener immediately when aborted", async () => {
    const harness = createAbortHarness();
    const neverSettles = new Promise(() => {});

    const wrapped = resolveUnlessAborted(neverSettles, harness.signal);
    assert.equal(harness.listenerCount, 1);

    harness.abort(new Error("auto-recall timeout"));

    await assert.rejects(wrapped, /auto-recall timeout/);
    assert.equal(harness.listenerCount, 0);
  });

  it("removes the abort listener when the wrapped promise resolves", async () => {
    const harness = createAbortHarness();
    let resolveWork = () => {};
    const work = new Promise((resolve) => {
      resolveWork = resolve;
    });

    const wrapped = resolveUnlessAborted(work, harness.signal);
    assert.equal(harness.listenerCount, 1);

    resolveWork("ok");

    assert.equal(await wrapped, "ok");
    assert.equal(harness.listenerCount, 0);

    harness.abort(new Error("late abort"));
    assert.equal(harness.listenerCount, 0);
  });
});
