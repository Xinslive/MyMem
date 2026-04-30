/**
 * Session Utilities
 *
 * Helper functions for working with sessions and conversation text.
 */

import { isNoise } from "./noise-filter.js";

/**
 * Extracts text content from various message content formats.
 */
export function extractTextContent(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text" && typeof (c as Record<string, unknown>).text === "string"
    ) as Record<string, unknown> | undefined;
    const text = block?.text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

/**
 * Check if a message should be skipped (slash commands, injected recall/system blocks).
 * Used by both the reflection pipeline and the auto-capture pipeline.
 */
export function shouldSkipReflectionMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/")) return true;

  if (role === "user") {
    if (
      trimmed.includes("<relevant-memories>") ||
      trimmed.includes("UNTRUSTED DATA") ||
      trimmed.includes("END UNTRUSTED DATA")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if text contains error signals for reflection error learning.
 */
export function containsErrorSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\[error\]|error:|exception:|fatal:|traceback|syntaxerror|typeerror|referenceerror|npm err!/.test(normalized) ||
    /command not found|no such file|permission denied|non-zero|exit code/.test(normalized) ||
    /"status"\s*:\s*"error"|"status"\s*:\s*"failed"|\biserror\b/.test(normalized) ||
    /错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/.test(normalized)
  );
}

/**
 * Summarizes error text for logging.
 */
export function summarizeErrorText(text: string, maxLen = 220): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty tool error)";
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 3)}...`;
}

/**
 * Creates SHA256 hash of text (hex string).
 */
export function sha256Hex(text: string): string {
  // Dynamic import to avoid circular deps
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalizes error signature for deduplication.
 */
export function normalizeErrorSignature(text: string): string {
  return redactSecrets(String(text || ""))
    .toLowerCase()
    .replace(/[a-z]:\\[^ \n\r\t]+/gi, "<path>")
    .replace(/\/[^ \n\r\t]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Extracts text from tool results.
 */
export function extractTextFromToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((c) => c && typeof c === "object")
        .map((c) => (c as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string");
      if (textParts.length > 0) return textParts.join("\n");
    }
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.details === "string") return obj.details;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/**
 * Summarizes recent conversation messages for reflection.
 */
export function summarizeRecentConversationMessages(
  messages: readonly unknown[],
  messageCount: number,
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const recent: string[] = [];
  for (let index = messages.length - 1; index >= 0 && recent.length < messageCount; index--) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;

    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role !== "user" && role !== "assistant") continue;

    const text = extractTextContent(msg.content);
    if (!text || shouldSkipReflectionMessage(role, text)) continue;

    recent.push(`${role}: ${redactSecrets(text)}`);
  }

  if (recent.length === 0) return null;
  recent.reverse();
  return recent.join("\n");
}

/**
 * Summarizes agent end messages for logging.
 */
export function summarizeAgentEndMessages(messages: unknown[]): string {
  const roleCounts = new Map<string, number>();
  let textBlocks = 0;
  let stringContents = 0;
  let arrayContents = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    const role =
      typeof msgObj.role === "string" && msgObj.role.trim().length > 0
        ? msgObj.role
        : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const content = msgObj.content;
    if (typeof content === "string") {
      stringContents++;
      continue;
    }
    if (Array.isArray(content)) {
      arrayContents++;
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          textBlocks++;
        }
      }
    }
  }

  const roles =
    Array.from(roleCounts.entries())
      .map(([role, count]) => `${role}:${count}`)
      .join(", ") || "none";

  return `messages=${messages.length}, roles=[${roles}], stringContents=${stringContents}, arrayContents=${arrayContents}, textBlocks=${textBlocks}`;
}

/**
 * Checks if text is an explicit "remember" command.
 */
const AUTO_CAPTURE_EXPLICIT_REMEMBER_RE =
  /^(?:请|請)?(?:记住|記住|记一下|記一下|别忘了|別忘了)[。.!?？!]*$/u;

export function isExplicitRememberCommand(text: string): boolean {
  return AUTO_CAPTURE_EXPLICIT_REMEMBER_RE.test(text.trim());
}

/**
 * Checks if text is likely noise.
 */
export function isNoiseText(text: string): boolean {
  return isNoise(text);
}

/**
 * Redacts secrets from text for logging.
 */
export function redactSecrets(text: string): string {
  const patterns: RegExp[] = [
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    /\bsk-proj-[A-Za-z0-9\-_]{20,}\b/g,
    /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    /\bghp_[A-Za-z0-9]{36,}\b/g,
    /\bgho_[A-Za-z0-9]{36,}\b/g,
    /\bghu_[A-Za-z0-9]{36,}\b/g,
    /\bghs_[A-Za-z0-9]{36,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bnpm_[A-Za-z0-9]{36,}\b/g,
    /\b(?:token|api[_-]?key|secret|password)\s*[:=]\s*["']?[^\s"',;)}\]]{6,}["']?\b/gi,
    /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
    /\/home\/[^\s"',;)}\]]+/g,
    /\/Users\/[^\s"',;)}\]]+/g,
    /[A-Z]:\\[^\s"',;)}\]]+/g,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ];

  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => (m.startsWith("Bearer") || m.startsWith("bearer") ? "Bearer [REDACTED]" : "[REDACTED]"));
  }
  return out;
}
