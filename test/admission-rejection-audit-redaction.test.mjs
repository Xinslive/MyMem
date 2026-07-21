/**
 * Regression test for CR-1 / P0-A (2026-07-21 review):
 * admission-rejection audit entries (CR-1 sink) and Markdown import sink
 * (CR-4) must never persist raw user-provided secrets.
 *
 * Covers:
 *  - sanitizeAdmissionRejectionAuditEntry applied to candidate.abstract,
 *    candidate.content, and conversation_excerpt.
 *  - createAdmissionRejectionAuditWriter in workspace-utils.ts applies the
 *    sanitizer and writes with mode 0o600.
 *  - FeedbackLoop.writeRejectionAuditEntry (the CR-1 reintroduction fixed
 *    in 2026-07-21) also applies the sanitizer and writes with mode 0o600.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { sanitizeAdmissionRejectionAuditEntry } = jiti(
  "../src/admission-control.ts",
);
const { createAdmissionRejectionAuditWriter } = jiti(
  "../src/workspace-utils.ts",
);

const SECRET = "sk-1234567890abcdefghijklmnop";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";

function buildEntry() {
  return {
    version: "amac-v1",
    rejected_at: 1700000000000,
    session_key: "session:test",
    target_scope: "agent:main",
    scope_filter: ["global", "agent:main"],
    candidate: {
      category: "patterns",
      abstract: `Lesson includes ${SECRET}`,
      content: `Auth header was ${BEARER} during the incident`,
    },
    audit: { decision: "reject" },
    conversation_excerpt:
      `User pasted this token: ${SECRET}\nplus header ${BEARER}`,
  };
}

describe("sanitizeAdmissionRejectionAuditEntry", () => {
  it("strips sk-* and Bearer tokens from candidate.abstract, candidate.content, and conversation_excerpt", () => {
    const safe = sanitizeAdmissionRejectionAuditEntry(buildEntry());
    const serialized = JSON.stringify(safe);
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiJ9\.payload\.signature/);
    assert.match(serialized, /\[REDACTED\]/);
  });
});

describe("createAdmissionRejectionAuditWriter (workspace-utils sink)", () => {
  it("writes sanitized entry to disk with mode 0o600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-audit-ws-"));
    try {
      const api = {
        resolvePath: (p) => p,
        logger: { info() {}, warn() {}, debug() {} },
      };
      const writer = createAdmissionRejectionAuditWriter(
        {
          admissionControl: { enabled: true, persistRejectedAudits: true },
        },
        join(dir, "db"),
        api,
      );
      assert.ok(writer, "writer should be created when persistRejectedAudits=true");
      await writer(buildEntry());

      const file = join(dir, "db", "..", "admission-audit", "rejections.jsonl");
      const line = readFileSync(file, "utf8").trim();
      assert.ok(line.length > 0);
      assert.doesNotMatch(line, new RegExp(SECRET));
      assert.doesNotMatch(line, /eyJhbGciOiJIUzI1NiJ9\.payload\.signature/);
      // mode 0o600 → owner read/write only (no group/other bits).
      const mode = statSync(file).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FeedbackLoop.writeRejectionAuditEntry (P0-A fix)", () => {
  // The CR-1 reintroduction fix went into FeedbackLoop. To exercise the sink
  // without booting the full feedback-loop runtime, we instantiate a
  // FeedbackLoop with a minimal stub and call onAdmissionRejected, which is
  // the public entry point that writes via writeRejectionAuditEntry.
  it("does not persist raw sk-* / Bearer tokens and writes with mode 0o600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-audit-fl-"));
    try {
      const { FeedbackLoop } = jiti("../src/feedback-loop.ts");
      const loop = new FeedbackLoop({
        admissionController: null,
        config: {
          enabled: true,
          priorAdaptation: {
            enabled: false,
            adaptationIntervalMs: 60000,
            minObservations: 5,
            learningRate: 0.1,
            maxAdjustment: 0.2,
            observationWindowMs: 86400000,
            maxRejectionAudits: 100,
          },
          preventiveLessons: {
            enabled: false,
            fromErrors: false,
            fromCorrections: false,
            minEvidenceToConfirm: 3,
            pendingConfidence: 0.4,
            confirmedConfidence: 0.7,
            maxLearnPerScan: 5,
          },
        },
        debugLog: () => {},
      });

      const dbPath = join(dir, "db");
      loop.setRuntimeContext({
        dbPath,
        admissionConfig: {
          enabled: true,
          persistRejectedAudits: true,
          // Explicit path keeps the test independent of dbPath layout.
          rejectedAuditFilePath: join(dir, "admission-audit", "rejections.jsonl"),
        },
      });

      loop.onAdmissionRejected(buildEntry());
      // The write is fire-and-forget through an in-process Set; with the
      // 2026-07-21 P1-H serialization queue the write sits behind any
      // in-flight actions on the same path, so poll for the file to appear.
      const file = join(dir, "admission-audit", "rejections.jsonl");
      for (let i = 0; i < 200; i += 1) {
        try {
          const stat = statSync(file);
          if (stat.size > 0) break;
        } catch {
          // file not yet created — keep polling
        }
        await new Promise((r) => setImmediate(r));
      }

      const line = readFileSync(file, "utf8").trim();
      assert.ok(line.length > 0, "rejection audit line should be written");
      assert.doesNotMatch(line, new RegExp(SECRET));
      assert.doesNotMatch(line, /eyJhbGciOiJIUzI1NiJ9\.payload\.signature/);
      const mode = statSync(file).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});