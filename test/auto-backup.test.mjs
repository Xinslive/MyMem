import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createAutoBackup } = jiti("../src/auto-backup.ts");

describe("auto backup lifecycle", () => {
  it("cancels both initial and recurring backup timers on stop", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const timeoutHandles = [];
    const clearedTimeoutHandles = [];
    const intervalHandles = [];
    const clearedIntervalHandles = [];

    try {
      globalThis.setTimeout = (fn, delay = 0, ...args) => {
        const handle = { fn, delay: Number(delay), args };
        timeoutHandles.push(handle);
        return handle;
      };
      globalThis.clearTimeout = (handle) => {
        clearedTimeoutHandles.push(handle);
      };
      globalThis.setInterval = (fn, delay = 0, ...args) => {
        const handle = { fn, delay: Number(delay), args };
        intervalHandles.push(handle);
        return handle;
      };
      globalThis.clearInterval = (handle) => {
        clearedIntervalHandles.push(handle);
      };

      const backup = createAutoBackup({
        api: {
          logger: { debug() {}, info() {}, warn() {} },
          resolvePath: (value) => value,
        },
        store: { list: async () => [] },
        resolvedDbPath: "/tmp/mymem-test-db",
      });

      backup.start();
      await backup.stop();

      assert.deepEqual(timeoutHandles.map((handle) => handle.delay), [60_000]);
      assert.deepEqual(clearedTimeoutHandles, timeoutHandles);
      assert.deepEqual(intervalHandles.map((handle) => handle.delay), [24 * 60 * 60 * 1000]);
      assert.deepEqual(clearedIntervalHandles, intervalHandles);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("waits for an in-flight backup before stop resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-auto-backup-"));
    let releaseList;
    let listStarted;
    const listStartedPromise = new Promise((resolve) => {
      listStarted = resolve;
    });
    try {
      const backup = createAutoBackup({
        api: {
          logger: { debug() {}, info() {}, warn() {} },
          resolvePath: (value) => value,
        },
        store: {
          list: async () => {
            listStarted();
            await new Promise((resolve) => {
              releaseList = resolve;
            });
            return [];
          },
        },
        resolvedDbPath: join(dir, "db"),
      });

      const backupPromise = backup.runBackup();
      await listStartedPromise;

      let stopResolved = false;
      const stopPromise = backup.stop().then(() => {
        stopResolved = true;
      });
      await Promise.resolve();
      assert.equal(stopResolved, false, "stop should wait for the in-flight backup");

      releaseList();
      await backupPromise;
      await stopPromise;
      assert.equal(stopResolved, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
