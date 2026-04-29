import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("compiled store native ESM can load LanceDB", async () => {
  const tempDir = mkdtempSync(join(repoRoot, ".tmp-native-esm-load-"));
  try {
    const tsconfigPath = join(tempDir, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: false,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            forceConsistentCasingInFileNames: true,
            skipLibCheck: true,
            types: ["node"],
            rootDir: "..",
            outDir: "./dist",
          },
          include: [
            "../src/store.ts",
            "../src/proper-lockfile.d.ts",
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const compile = spawnSync(process.execPath, [tscBin, "-p", tsconfigPath], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);

    const compiledStoreUrl = pathToFileURL(join(tempDir, "dist", "src", "store.js")).href;
    const mod = await import(compiledStoreUrl);
    const lancedb = await mod.loadLanceDB();
    assert.equal(typeof lancedb.connect, "function");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
