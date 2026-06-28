import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { withTimeout } = jiti("../src/cli-utils.ts");

describe("cli-utils withTimeout", () => {
  it("keeps legacy promise wrapping behavior", async () => {
    const value = await withTimeout(Promise.resolve("ok"), 100, "legacy operation");

    assert.equal(value, "ok");
  });

  it("aborts cancellable work when the timeout elapses", async () => {
    let seenSignal;
    let abortReason;

    await assert.rejects(
      withTimeout(
        (signal) => {
          seenSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              abortReason = signal.reason;
              reject(signal.reason);
            }, { once: true });
          });
        },
        20,
        "embedded reflection run"
      ),
      /embedded reflection run timed out after 20ms/
    );

    assert.ok(seenSignal instanceof AbortSignal);
    assert.equal(seenSignal.aborted, true);
    assert.match(abortReason?.message, /embedded reflection run timed out after 20ms/);
  });
});
