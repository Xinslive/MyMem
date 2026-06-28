import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ConcurrencyLimiter } = jiti("../src/concurrency-limiter.ts");

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

describe("ConcurrencyLimiter", () => {
  it("removes abort listeners when a queued acquire is aborted", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const harness = createAbortHarness();

    const queued = limiter.acquire(harness.signal);
    assert.equal(harness.listenerCount, 1);

    harness.abort(new Error("caller cancelled"));

    await assert.rejects(queued, /caller cancelled/);
    assert.equal(harness.listenerCount, 0);

    release();
    const nextRelease = await limiter.acquire();
    nextRelease();
  });

  it("removes abort listeners when a queued acquire receives a permit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const harness = createAbortHarness();

    const queued = limiter.acquire(harness.signal);
    assert.equal(harness.listenerCount, 1);

    release();
    const queuedRelease = await queued;

    assert.equal(harness.listenerCount, 0);
    harness.abort(new Error("late abort"));
    assert.equal(harness.listenerCount, 0);

    queuedRelease();
  });

  it("skips aborted queued acquires without consuming the released permit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const firstRelease = await limiter.acquire();
    const firstQueued = createAbortHarness();
    const secondQueued = createAbortHarness();

    const abortedAcquire = limiter.acquire(firstQueued.signal);
    const waitingAcquire = limiter.acquire(secondQueued.signal);
    firstQueued.abort(new Error("first cancelled"));

    await assert.rejects(abortedAcquire, /first cancelled/);
    firstRelease();

    const secondRelease = await waitingAcquire;
    assert.equal(secondQueued.listenerCount, 0);
    secondRelease();
  });
});
