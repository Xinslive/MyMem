import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createAdmissionRejectionAuditWriter } = jiti("../src/workspace-utils.ts");
const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");

describe("admission rejection audit redaction", () => {
  it("redacts secrets from admission decision debug logs", async () => {
    const debugLogs = [];
    const controller = new AdmissionController(
      {
        async vectorSearch() {
          return [];
        },
      },
      {
        async completeJson() {
          return { utility: 0.9, reason: "worth keeping" };
        },
      },
      normalizeAdmissionControlConfig({
        enabled: true,
        utilityMode: "off",
      }),
      (message) => debugLogs.push(String(message)),
    );

    await controller.evaluate({
      candidate: {
        category: "patterns",
        abstract: "Use password:hunter2-please-rotate-q1-2026 for the temporary database",
        content: "temporary database credentials",
      },
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: "conversation",
      scopeFilter: ["global"],
    });

    const serialized = debugLogs.join("\n");
    assert.doesNotMatch(serialized, /hunter2-please-rotate-q1-2026/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it("redacts secrets from persisted rejected candidates and excerpts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mymem-admission-audit-"));
    const auditPath = join(dir, "rejections.jsonl");
    try {
      const writer = createAdmissionRejectionAuditWriter(
        {
          admissionControl: {
            enabled: true,
            persistRejectedAudits: true,
            rejectedAuditFilePath: auditPath,
          },
        },
        join(dir, "db"),
        {
          resolvePath: (target) => target,
          logger: { warn() {} },
        },
      );

      assert.equal(typeof writer, "function");
      await writer({
        version: "amac-v1",
        rejected_at: Date.now(),
        session_key: "agent:main:test",
        target_scope: "global",
        scope_filter: ["global"],
        candidate: {
          category: "patterns",
          abstract: "Use token sk-1234567890abcdefghijklmnop carefully",
          content: "密码：supersecret and webhook token=abc123456",
        },
        audit: {
          version: "amac-v1",
          decision: "reject",
          score: 0.1,
          reason: "low_value",
          thresholds: { reject: 0.45, admit: 0.6 },
          weights: { utility: 0.2, confidence: 0.2, novelty: 0.2, recency: 0.2, typePrior: 0.2 },
          feature_scores: { utility: 0, confidence: 0, novelty: 0, recency: 0, typePrior: 0 },
          matched_existing_memory_ids: [],
          compared_existing_memory_ids: [],
          max_similarity: 0,
          evaluated_at: Date.now(),
        },
        conversation_excerpt: "Bearer abc123xyz789123456789123456789123456789 and password: hunter2",
      });

      const raw = readFileSync(auditPath, "utf8");
      assert.doesNotMatch(raw, /sk-1234567890abcdefghijklmnop/);
      assert.doesNotMatch(raw, /supersecret/);
      assert.doesNotMatch(raw, /abc123xyz789123456789123456789123456789/);
      assert.doesNotMatch(raw, /hunter2/);
      assert.match(raw, /\[REDACTED\]/);
      assert.match(raw, /Bearer \[REDACTED\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
