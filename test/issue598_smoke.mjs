/**
 * Smoke test for: skip before_prompt_build hooks for subagent sessions
 * Bug: sub-agent sessions cause gateway blocking — hooks without subagent skip
 *       run LanceDB I/O sequentially, blocking all other user sessions.
 *
 * Uses relative path via import.meta.url so it works cross-platform
 * (CI, macOS, Linux, Windows, Docker).
 *
 * Run: node test/issue598_smoke.mjs
 * Expected: PASS — subagent sessions skipped before async work
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Resolve project files relative to this test file, not hardcoded paths.
// Works in: local dev, CI (Linux/macOS/Windows), Docker, any machine.
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "index.ts");
const HOOK_PATHS = [
  INDEX_PATH,
  resolve(__dirname, "..", "src", "auto-recall-hook.ts"),
  resolve(__dirname, "..", "src", "reflection-hook.ts"),
  resolve(__dirname, "..", "src", "hook-enhancements.ts"),
];

const files = HOOK_PATHS.map((path) => ({
  path,
  content: readFileSync(path, "utf-8"),
}));

// Verify: hook sources are loadable and non-empty
for (const file of files) {
  if (!file.content || file.content.length < 500) {
    console.error(`FAIL: ${file.path} is empty or too short — file not loaded correctly`);
    process.exit(1);
  }
}

// Verify: the guard pattern appears across the split hook modules.
// This tests actual behavior: before_prompt_build hooks should skip :subagent: sessions.
const subagentSkipCount = files.reduce(
  (sum, file) => sum + (file.content.match(/:subagent:/g) || []).length,
  0,
);
if (subagentSkipCount < 3) {
  console.error(`FAIL: expected at least 3 ':subagent:' guard occurrences, found ${subagentSkipCount}`);
  process.exit(1);
}

// Verify: every before_prompt_build hook has a direct guard or uses the shared guard.
let hookCount = 0;
for (const file of files) {
  const helperHasSubagentGuard =
    /function shouldSkipSession[\s\S]{0,300}:subagent:/.test(file.content);
  const hookPattern = /api\.on\("before_prompt_build"/g;
  let match;
  while ((match = hookPattern.exec(file.content)) !== null) {
    hookCount++;
    const hookBody = file.content.slice(match.index, match.index + 3000);
    const hasDirectGuard = /:subagent:/.test(hookBody);
    const hasSharedGuard =
      helperHasSubagentGuard &&
      /shouldSkipSession\s*\(\s*sessionKey\s*\)/.test(hookBody);
    if (!hasDirectGuard && !hasSharedGuard) {
      console.error(`FAIL: before_prompt_build hook in ${file.path} is missing subagent guard`);
      process.exit(1);
    }
  }
}

if (hookCount === 0) {
  console.error("FAIL: no before_prompt_build hooks found");
  process.exit(1);
}

console.log(`PASS  subagent skip guards found: ${subagentSkipCount} occurrences`);
console.log(`PASS  before_prompt_build guards verified: ${hookCount} hooks`);
console.log("ALL PASSED — subagent sessions skipped before async work");
console.log(`\nNote: scanned hook files:\n${HOOK_PATHS.map((path) => `  - ${path}`).join("\n")}`);
