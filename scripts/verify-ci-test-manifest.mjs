import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_TEST_GROUPS, CI_TEST_MANIFEST } from "./ci-test-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function normalizeArgs(args = []) {
  return args;
}

function formatCommand(entry) {
  return [entry.runner, ...normalizeArgs(entry.args), entry.file].join(" ");
}

function listTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (relativePath === "test/helpers") continue;
      files.push(...listTestFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function verifyGroups() {
  for (const entry of CI_TEST_MANIFEST) {
    if (!CI_TEST_GROUPS.includes(entry.group)) {
      fail(`invalid CI test group: ${entry.group} for ${entry.file}`);
    }
  }
}

function verifyFilesExist() {
  for (const entry of CI_TEST_MANIFEST) {
    const absolutePath = path.resolve(repoRoot, entry.file);
    if (!fs.existsSync(absolutePath)) {
      fail(`missing test file on disk: ${entry.file}`);
    }
  }
}

function verifyExactOnceCoverage() {
  const counts = new Map();
  for (const entry of CI_TEST_MANIFEST) {
    counts.set(entry.file, (counts.get(entry.file) ?? 0) + 1);
  }

  for (const [file, count] of counts) {
    if (count > 1) {
      fail(`duplicate test entry: ${file}`);
    }
  }

  const manifestFiles = [...counts.keys()].sort();
  const diskFiles = listTestFiles(path.resolve(repoRoot, "test"));
  const manifestSet = new Set(manifestFiles);
  const diskSet = new Set(diskFiles);

  const missing = diskFiles.filter((file) => !manifestSet.has(file));
  const unexpected = manifestFiles.filter((file) => !diskSet.has(file));

  if (missing.length > 0) {
    fail(`test files missing from CI manifest:\n${missing.map((file) => `  - ${file}`).join("\n")}`);
  }

  if (unexpected.length > 0) {
    fail(`CI manifest entries without test files:\n${unexpected.map((file) => `  - ${file}`).join("\n")}`);
  }
}

function verifyCommands() {
  for (const entry of CI_TEST_MANIFEST) {
    if (entry.runner !== "node") {
      fail(`unsupported runner for ${entry.file}: ${entry.runner}`);
    }

    const args = normalizeArgs(entry.args);
    const usesNodeTest = args.includes("--test");
    const source = fs.readFileSync(path.resolve(repoRoot, entry.file), "utf8");
    const importsNodeTest = source.includes("node:test");

    if (importsNodeTest && !usesNodeTest) {
      fail(`node:test file should run with --test: ${formatCommand(entry)}`);
    }
  }
}

function main() {
  verifyGroups();
  verifyFilesExist();
  verifyExactOnceCoverage();
  verifyCommands();
  console.log(`CI test manifest covers all test files exactly once (${CI_TEST_MANIFEST.length} entries)`);
}

main();
