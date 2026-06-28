import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "mymem-audit-log-"));
  return {
    dir,
    store: new MemoryStore({ dbPath: dir, vectorDim: 4 }),
  };
}

function makeEntry(text = "audited memory") {
  return {
    text,
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "global",
    importance: 0.6,
    metadata: "{}",
  };
}

async function readAuditEntries(filePath, expectedCount = 1) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(filePath), "audit.jsonl should be written");

  while (Date.now() < deadline) {
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

describe("MemoryStore audit log", () => {
  it("records store, update, and delete mutations without memory text", async () => {
    const { dir, store } = makeStore();
    try {
      const entry = await store.store(makeEntry("sensitive text should not enter audit log"));
      await store.update(entry.id, {
        text: "updated sensitive text should not enter audit log",
        vector: [0, 1, 0, 0],
      });
      assert.equal(await store.delete(entry.id), true);
      await store.flushAuditLog();

      const entries = await readAuditEntries(join(dir, "audit.jsonl"), 3);
      assert.deepEqual(entries.map((item) => item.op), ["store", "update", "delete"]);
      assert.deepEqual(new Set(entries.map((item) => item.id)), new Set([entry.id]));
      assert.ok(entries.every((item) => typeof item.at === "string" && item.at.length > 0));
      assert.ok(entries.every((item) => typeof item.detail === "string"));
      assert.doesNotMatch(JSON.stringify(entries), /sensitive text/);
      assert.match(entries[1].detail, /fields=text,vector/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can be disabled for tests or embedded stores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-audit-log-disabled-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4, auditLogEnabled: false });
    try {
      const entry = await store.store(makeEntry());
      await store.delete(entry.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(existsSync(join(dir, "audit.jsonl")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
