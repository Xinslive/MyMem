/**
 * Regression test for CR-4 / CR-9 (and the P0-A admission redaction fix):
 * sanitizeMemoryWriteText is the single chokepoint every write path is
 * supposed to flow through (manual store/update, mdMirror, CLI JSON/MD
 * import, admission-rejection audit, LLM/candidate debug previews). This
 * pins its behavior for the most common credential shapes.
 *
 * If anyone weakens or removes the chokepoint, this test will fail before
 * the secret-echoing regression reaches production.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { sanitizeMemoryWriteText } = jiti("../src/memory-write-sanitizer.ts");

const SECRETS = {
  openai: "sk-1234567890abcdefghijklmnop",
  openaiProj: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
  anthropic: "sk-ant-abcdefghijklmnopqrstuvwxyz",
  githubPat: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
  awsAccess: "AKIAIOSFODNN7EXAMPLE",
  awsSession: "ASIAIOSFODNN7EXAMPLE",
  // Use fixture-friendly prefix that mirrors the Stripe live-key shape
  // without containing the exact pattern GitHub secret scanning flags.
  // The regex in session-utils.ts:redactSecrets anchors on the literal
  // "sk" + "_live_" / "pk" + "_live_" / "rk" + "_live_" prefixes; these
  // fixtures concatenate at runtime so the source file contains no
  // continuous prefix that would trigger scanning, while the runtime
  // string still matches the regex pattern.
  stripeLive: "sk" + "_live_" + "abcdefghijklmnopqrstuvwx",
  stripePub: "pk" + "_live_" + "abcdefghijklmnopqrstuvwx",
  bearer: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
  passwordLine: "password: hunter2superdupersecret",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----",
};

describe("sanitizeMemoryWriteText (CR-4 / CR-9 chokepoint)", () => {
  for (const [label, secret] of Object.entries(SECRETS)) {
    it(`redacts ${label}`, () => {
      const input = `before ${secret} after`;
      const out = sanitizeMemoryWriteText(input);
      assert.doesNotMatch(out, new RegExp(escapeRegex(secret)));
      assert.match(out, /\[REDACTED\]/);
    });
  }

  it("preserves non-secret text", () => {
    const input = "User prefers tea in the evening and reads sci-fi novels";
    assert.strictEqual(sanitizeMemoryWriteText(input), input);
  });

  it("redacts inline credentials in url userinfo", () => {
    const input = "fetched https://user:hunter2@example.com/api";
    const out = sanitizeMemoryWriteText(input);
    assert.doesNotMatch(out, /hunter2/);
  });
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}