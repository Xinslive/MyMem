import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

const CLAUDE_WORKFLOW_PATH = new URL("../.github/workflows/claude-code-review.yml", import.meta.url);
const AUTO_ASSIGN_PATH = new URL("../.github/workflows/auto-assign.yml", import.meta.url);

const CLAUDE_WORKFLOW = existsSync(CLAUDE_WORKFLOW_PATH)
  ? readFileSync(CLAUDE_WORKFLOW_PATH, "utf8")
  : null;
const AUTO_ASSIGN_WORKFLOW = existsSync(AUTO_ASSIGN_PATH)
  ? readFileSync(AUTO_ASSIGN_PATH, "utf8")
  : null;

test("claude review skips fork pull requests", () => {
  if (!CLAUDE_WORKFLOW) {
    return; // skip — workflow file not present in this repo
  }
  assert.match(
    CLAUDE_WORKFLOW,
    /if:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.fork == false\s*\}\}/m,
  );
});

test("PR auto-assignment skips fork pull requests", () => {
  if (!AUTO_ASSIGN_WORKFLOW) {
    return; // skip — workflow file not present in this repo
  }
  assert.match(
    AUTO_ASSIGN_WORKFLOW,
    /assign-prs:\s*\n\s*if:\s*github\.event_name == 'pull_request'\s*&&\s*github\.event\.pull_request\.head\.repo\.fork == false/m,
  );
});
