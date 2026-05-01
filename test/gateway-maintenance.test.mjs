import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { __test__ } = jiti("../src/plugin-registration.ts");

describe("gateway maintenance", () => {
  it("runs lifecycle once in all phase and logs the single scan count", async () => {
    const calls = [];
    const infoLogs = [];
    const ctx = {
      api: {
        logger: {
          info(message) { infoLogs.push(String(message)); },
          warn() {},
          debug() {},
        },
      },
      config: {
        lifecycleMaintenance: {
          enabled: true,
          cooldownHours: 4,
          maxMemoriesToScan: 500,
          archiveThreshold: 0.15,
          dryRun: false,
          deleteMode: "archive",
        },
        memoryCompaction: {
          enabled: true,
          cooldownHours: 4,
        },
      },
      store: {
        getById: async () => null,
        update: async () => {},
      },
      embedder: {},
      decayEngine: {},
      tierManager: {},
      smartExtractionLlmClient: null,
      resolvedDbPath: path.join(tmpdir(), "mymem-gateway-maintenance", "db"),
    };
    const deps = {
      shouldRunPreferenceDistiller: async () => false,
      runPreferenceDistiller: async () => ({ created: 0, updated: 0 }),
      recordPreferenceDistillerRun: async () => {},
      shouldRunExperienceCompiler: async () => false,
      runExperienceCompiler: async () => ({ created: 0, updated: 0 }),
      recordExperienceCompilerRun: async () => {},
      shouldRunLifecycleMaintenance: async () => true,
      runLifecycleMaintenance: async (_deps, cfg) => {
        calls.push({ type: "lifecycle", phase: cfg.phase });
        return {
          scanned: 7,
          archived: 1,
          deleted: 2,
          deleteReasons: { expired: 2 },
          promoted: 3,
          demoted: 4,
          skipped: 0,
          dryRun: false,
        };
      },
      recordLifecycleMaintenanceRun: async () => {
        calls.push({ type: "record-lifecycle" });
      },
      shouldRunCompaction: async () => true,
      runCompaction: async () => {
        calls.push({ type: "compaction" });
        return {
          scanned: 11,
          clustersFound: 1,
          memoriesCreated: 1,
          memoriesDeleted: 5,
          llmRefined: 0,
          fallbackMerged: 1,
          failedClusters: 0,
        };
      },
      recordCompactionRun: async () => {},
    };

    await __test__.runGatewayMaintenanceOnce(ctx, deps);

    assert.deepEqual(calls, [
      { type: "lifecycle", phase: "all" },
      { type: "record-lifecycle" },
      { type: "compaction" },
    ]);
    assert.equal(infoLogs.length, 1);
    assert.match(infoLogs[0], /lifecycleScanned=7\b/);
    assert.doesNotMatch(infoLogs[0], /lifecycleScanned=14\b/);
    assert.match(infoLogs[0], /deleted=7\b/);
    assert.match(infoLogs[0], /promoted=3 demoted=4\b/);
  });
});
