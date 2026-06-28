import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { writeJsonFileAtomic } = jiti("../src/file-utils.ts");
const { recordCompactionRun, shouldRunCompaction } = jiti("../src/memory-compactor.ts");
const {
  recordLifecycleMaintenanceRun,
  shouldRunLifecycleMaintenance,
} = jiti("../src/lifecycle-maintainer.ts");
const {
  recordPreferenceDistillerRun,
  shouldRunPreferenceDistiller,
} = jiti("../src/preference-distiller.ts");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mymem-maintenance-state-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      try {
        rmSync(dir, { recursive: true });
      } catch {}
    });
}

describe("maintenance state files", () => {
  it("writes JSON atomically without leaving sibling temp files", async () => withTempDir(async (dir) => {
    const stateFile = join(dir, "nested", "state.json");

    await writeJsonFileAtomic(stateFile, { lastRunAt: 123, ok: true });

    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { lastRunAt: 123, ok: true });
    assert.deepEqual(readdirSync(join(dir, "nested")), ["state.json"]);
  }));

  it("records compaction cooldown state through the atomic writer", async () => withTempDir(async (dir) => {
    const stateFile = join(dir, ".memory-compaction-state.json");

    await recordCompactionRun(stateFile);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(typeof state.lastRunAt, "number");
    assert.equal(await shouldRunCompaction(stateFile, 4), false);
  }));

  it("records lifecycle and preference distiller cooldown state through the shared atomic writer", async () => withTempDir(async (dir) => {
    const lifecycleStateFile = join(dir, ".lifecycle-maintenance-state.json");
    const distillerStateFile = join(dir, ".preference-distiller-state.json");

    await recordLifecycleMaintenanceRun(lifecycleStateFile);
    await recordPreferenceDistillerRun(distillerStateFile);

    assert.equal(await shouldRunLifecycleMaintenance(lifecycleStateFile, 4), false);
    assert.equal(await shouldRunPreferenceDistiller(distillerStateFile, 4), false);
  }));
});
