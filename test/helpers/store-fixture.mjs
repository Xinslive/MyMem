/**
 * Minimal temp-store fixture for tests that need a real MemoryStore backed
 * by a tmpdir LanceDB. Replaces the larger helpers/store-fixture.mjs that
 * was removed in commit b6dd1ca.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../../src/store.ts");

export function makeTempMemoryStore({
  prefix = "mymem-store-",
  vectorDim = 3,
  logger,
  auditLogEnabled = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const config = { dbPath: dir, vectorDim, auditLogEnabled };
  if (logger !== undefined) config.logger = logger;
  return {
    dir,
    store: new MemoryStore(config),
  };
}