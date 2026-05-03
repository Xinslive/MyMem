import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowedRuntimeStoreFiles = new Set([
  "src/store.ts",
  "src/tools-store.ts",
  "src/tools-update.ts",
  "src/smart-extractor-handlers.ts",
  "src/reflection-hook.ts",
  "src/reflection-store.ts",
]);

const allowedAdminStoreFiles = new Set([
  "cli.ts",
]);

describe("runtime memory write policy", () => {
  it("keeps runtime main-memory creation limited to manual and auto-capture paths", () => {
    const files = [
      "cli.ts",
      "index.ts",
      "src/tools-store.ts",
      "src/tools-update.ts",
      "src/smart-extractor-handlers.ts",
      "src/reflection-hook.ts",
      "src/reflection-store.ts",
      "src/session-memory-hook.ts",
      "src/preference-distiller.ts",
      "src/experience-compiler.ts",
      "src/feedback-loop.ts",
      "src/hook-enhancements.ts",
      "src/memory-compactor.ts",
      "src/store.ts",
    ];

    const offenders = [];
    for (const file of files) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      if (!/\.store\s*\(/.test(source)) continue;
      if (allowedRuntimeStoreFiles.has(file) || allowedAdminStoreFiles.has(file)) continue;
      offenders.push(file);
    }

    assert.deepEqual(offenders, []);
  });

  it("keeps reflection persistence pointed at the reflection store only", () => {
    const hookSource = readFileSync(path.join(repoRoot, "src/reflection-hook.ts"), "utf8");
    assert.doesNotMatch(hookSource, /\bstore\.store\s*\(/);
    assert.match(hookSource, /\breflectionStore\.store\s*\(/);
    assert.match(hookSource, /store:\s*\(entry\)\s*=>\s*reflectionStore\.store\(entry\)/);
  });
});
