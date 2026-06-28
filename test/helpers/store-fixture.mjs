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
  auditLogEnabled,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const config = { dbPath: dir, vectorDim, auditLogEnabled: auditLogEnabled ?? false };
  if (logger !== undefined) config.logger = logger;
  return {
    dir,
    store: new MemoryStore(config),
  };
}

export function makeMemoryEntry(i = 1, overrides = {}) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "cases",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
    ...overrides,
  };
}
