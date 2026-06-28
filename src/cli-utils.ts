/**
 * CLI Utilities
 *
 * Helper functions for CLI operations, JSON parsing, and timeout handling.
 */

import { parsePositiveInt } from "./config-utils.js";

/**
 * Converts a value to a non-empty trimmed string, or undefined if empty/invalid.
 */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

type TimeoutWork<T> = Promise<T> | ((signal: AbortSignal) => Promise<T>);

/**
 * Wraps a promise or cancellable work function with a timeout.
 */
export function withTimeout<T>(work: TimeoutWork<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = typeof work === "function" ? new AbortController() : undefined;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      controller?.abort(error);
      finish(() => reject(error));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let promise: Promise<T>;
    try {
      promise = typeof work === "function" ? work(controller!.signal) : work;
    } catch (err) {
      finish(() => reject(err));
      return;
    }

    promise.then(
      (value) => {
        finish(() => resolve(value));
      },
      (err) => {
        finish(() => reject(err));
      }
    );
  });
}

/**
 * Tries to parse a string as a JSON object.
 */
export function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Clips diagnostic text to a maximum length.
 */
export function clipDiagnostic(text: string, maxLen = 400): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

/**
 * Resolves LLM timeout in milliseconds from plugin config.
 */
export function resolveLlmTimeoutMs(config: { llm?: { timeoutMs?: unknown } }): number {
  return parsePositiveInt(config.llm?.timeoutMs) ?? 90000;
}

/**
 * Extracts a JSON object from CLI output (handles multi-line, prefixed JSON).
 */
export function extractJsonObjectFromOutput(stdout: string, clipDiagFn?: (text: string, maxLen?: number) => string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("empty stdout");

  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("{")) continue;
    const candidate = lines.slice(i).join("\n");
    const parsed = tryParseJsonObject(candidate);
    if (parsed) return parsed;
  }

  const clip = clipDiagFn || ((t: string, m = 280) => t.length <= m ? t : `${t.slice(0, m)}...`);
  throw new Error(`unable to parse JSON from CLI output: ${clip(trimmed, 280)}`);
}

/**
 * Extracts reflection text from CLI result object.
 */
export function extractReflectionTextFromCliResult(resultObj: Record<string, unknown>): string | null {
  const result = resultObj.result as Record<string, unknown> | undefined;
  const payloads = Array.isArray(resultObj.payloads)
    ? resultObj.payloads
    : Array.isArray(result?.payloads)
      ? result.payloads
      : [];
  const firstWithText = payloads.find(
    (p) => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" && ((p as Record<string, unknown>).text as string).trim().length
  ) as Record<string, unknown> | undefined;
  const text = typeof firstWithText?.text === "string" ? firstWithText.text.trim() : "";
  return text || null;
}

/**
 * Sanitizes a string to be used as a file token/name.
 * Normalizes to lowercase alphanumeric with hyphens, max 32 chars.
 */
export function sanitizeFileToken(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || fallback;
}
