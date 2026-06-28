/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */

import OpenAI from "openai";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  buildOauthEndpoint,
  extractOutputTextFromSse,
  loadOAuthSession,
  needsRefresh,
  normalizeOauthModel,
  refreshOAuthSession,
  saveOAuthSession,
} from "./llm-oauth.js";
import { globalLlmRequestLimiter } from "./concurrency-limiter.js";

export interface LlmClientConfig {
  apiKey?: string;
  model: string;
  baseURL?: string;
  auth?: "api-key" | "oauth";
  oauthPath?: string;
  oauthProvider?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Warn-level logger for user-visible failures (timeouts, retries, network errors). */
  warnLog?: (msg: string) => void;
}

export interface LlmClient {
  /** Send a prompt and parse the JSON response. Returns null on failure. */
  completeJson<T>(prompt: string, label?: string, schema?: TSchema): Promise<T | null>;
  /** Best-effort diagnostics for the most recent failure, if any. */
  getLastError(): string | null;
  /** Count of completeJson failures observed by this client instance. */
  readonly recentErrorCount: number;
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;
  return text.substring(firstBrace, lastBrace + 1);
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function nextNonWhitespaceChar(text: string, start: number): string | undefined {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) return ch;
  }
  return undefined;
}

/**
 * Best-effort repair for common LLM JSON issues:
 * - unescaped quotes inside string values
 * - raw newlines / tabs inside strings
 * - trailing commas before } or ]
 */
function repairCommonJson(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }

      if (ch === "\"") {
        const nextCh = nextNonWhitespaceChar(text, i + 1);
        if (
          nextCh === undefined ||
          nextCh === "," ||
          nextCh === "}" ||
          nextCh === "]" ||
          nextCh === ":"
        ) {
          result += ch;
          inString = false;
        } else {
          result += "\\\"";
        }
        continue;
      }

      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === "\"") {
      result += ch;
      inString = true;
      continue;
    }

    if (ch === ",") {
      const nextCh = nextNonWhitespaceChar(text, i + 1);
      if (nextCh === "}" || nextCh === "]") {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

function looksLikeSseResponse(bodyText: string): boolean {
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function createTimeoutSignal(timeoutMs?: number): { signal: AbortSignal; dispose: () => void } {
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

const LLM_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 100;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  const match = errorMessage(error).match(/\b(?:HTTP\s*)?(408|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : undefined;
}

function isRetryableLlmError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return RETRYABLE_HTTP_STATUSES.has(status);

  return /(?:fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed?\s*out)/i.test(
    errorMessage(error),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function schemaValidationError(schema: TSchema | undefined, value: unknown): string | null {
  if (!schema || Value.Check(schema, value)) return null;
  const firstError = [...Value.Errors(schema, value)][0];
  if (!firstError) return "schema validation failed";
  return `${firstError.path || "/"}: ${firstError.message}`;
}

function parseAndValidateJson<T>(
  jsonStr: string,
  params: {
    label: string;
    sourceLabel: string;
    schema?: TSchema;
    log: (msg: string) => void;
  },
): { value: T | null; error?: string } {
  const parseCandidate = (candidateJson: string, repaired: boolean): { value: T | null; error?: string } => {
    const parsed = JSON.parse(candidateJson) as unknown;
    const schemaError = schemaValidationError(params.schema, parsed);
    if (schemaError) {
      return {
        value: null,
        error:
          `mymem: llm-client [${params.label}] ${params.sourceLabel}schema validation failed${repaired ? " after repair" : ""}: ${schemaError} ` +
          `(jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
      };
    }
    if (repaired) {
      params.log(
        `mymem: llm-client [${params.label}] recovered malformed ${params.sourceLabel}JSON via heuristic repair (jsonChars=${jsonStr.length})`,
      );
    }
    return { value: parsed as T };
  };

  try {
    return parseCandidate(jsonStr, false);
  } catch (err) {
    const repairedJsonStr = repairCommonJson(jsonStr);
    if (repairedJsonStr !== jsonStr) {
      try {
        return parseCandidate(repairedJsonStr, true);
      } catch (repairErr) {
        return {
          value: null,
          error:
            `mymem: llm-client [${params.label}] ${params.sourceLabel}JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; ` +
            `repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} ` +
            `(jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
        };
      }
    }
    return {
      value: null,
      error:
        `mymem: llm-client [${params.label}] ${params.sourceLabel}JSON.parse failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
    };
  }
}

async function withLlmRetries<T>(
  operation: () => Promise<T>,
  params: {
    label: string;
    model: string;
    log: (msg: string) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= LLM_MAX_ATTEMPTS || !isRetryableLlmError(error)) {
        throw error;
      }

      const delayMs = LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      params.log(
        `mymem: llm-client [${params.label}] transient request failure for model ${params.model}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${LLM_MAX_ATTEMPTS}): ${errorMessage(error)}`,
      );
      await delay(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createApiKeyClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
  if (!config.apiKey) {
    throw new Error("LLM api-key mode requires llm.apiKey or embedding.apiKey");
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 30000,
    maxRetries: 0,
  });
  let lastError: string | null = null;
  let errorCount = 0;

  return {
    async completeJson<T>(prompt: string, label = "generic", schema?: TSchema): Promise<T | null> {
      lastError = null;
      const release = await globalLlmRequestLimiter.acquire();
      try {
        const response = await withLlmRetries(
          () => client.chat.completions.create({
            model: config.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a memory extraction assistant. Always respond with valid JSON only.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.1,
          }),
          { label, model: config.model, log },
        );

        const raw = response.choices?.[0]?.message?.content;
        if (!raw) {
          lastError =
            `mymem: llm-client [${label}] empty response content from model ${config.model}`;
          log(lastError);
          errorCount++;
          return null;
        }
        if (typeof raw !== "string") {
          lastError =
            `mymem: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${config.model}`;
          log(lastError);
          errorCount++;
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          lastError =
            `mymem: llm-client [${label}] no JSON object found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
          log(lastError);
          errorCount++;
          return null;
        }

        const parsed = parseAndValidateJson<T>(jsonStr, { label, sourceLabel: "", schema, log });
        if (!parsed.value) {
          lastError = parsed.error ?? `mymem: llm-client [${label}] JSON response validation failed`;
          log(lastError);
          errorCount++;
          return null;
        }
        return parsed.value;
      } catch (err) {
        lastError =
          `mymem: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        (warnLog ?? log)(lastError);
        errorCount++;
        return null;
      } finally {
        release();
      }
    },
    getLastError(): string | null {
      return lastError;
    },
    /** Count of recent completeJson failures (resets on session restart). */
    get recentErrorCount(): number {
      return errorCount;
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
  if (!config.oauthPath) {
    throw new Error("LLM oauth mode requires llm.oauthPath");
  }

  let cachedSessionPromise: Promise<Awaited<ReturnType<typeof loadOAuthSession>>> | null = null;
  let lastError: string | null = null;
  let errorCount = 0;

  async function getSession() {
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(config.oauthPath!).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      try {
        session = await refreshOAuthSession(session, config.timeoutMs);
        await saveOAuthSession(config.oauthPath!, session);
        cachedSessionPromise = Promise.resolve(session);
      } catch (error) {
        cachedSessionPromise = null;
        throw error;
      }
    }
    return session;
  }

  return {
    async completeJson<T>(prompt: string, label = "generic", schema?: TSchema): Promise<T | null> {
      lastError = null;
      const release = await globalLlmRequestLimiter.acquire();
      try {
        const session = await getSession();
        const { signal, dispose } = createTimeoutSignal(config.timeoutMs);
        const endpoint = buildOauthEndpoint(config.baseURL, config.oauthProvider);
        try {
          const response = await withLlmRetries(
            async () => {
              const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${session.accessToken}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  "OpenAI-Beta": "responses=experimental",
                  "chatgpt-account-id": session.accountId,
                  originator: "codex_cli_rs",
                },
                signal,
                body: JSON.stringify({
                  model: normalizeOauthModel(config.model),
                  instructions:
                    "You are a memory extraction assistant. Always respond with valid JSON only.",
                  input: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: prompt,
                        },
                      ],
                    },
                  ],
                  store: false,
                  stream: true,
                  text: {
                    format: { type: "text" },
                  },
                }),
              });

              if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
              }
              return response;
            },
            { label, model: config.model, log },
          );

          const bodyText = await response.text();
          const raw = (
            response.headers.get("content-type")?.includes("text/event-stream") ||
            looksLikeSseResponse(bodyText)
          )
            ? extractOutputTextFromSse(bodyText)
            : (() => {
                try {
                  const parsed = JSON.parse(bodyText) as Record<string, unknown>;
                  const output = Array.isArray(parsed.output) ? parsed.output : [];
                  const first = output.find(
                    (item) =>
                      item &&
                      typeof item === "object" &&
                      Array.isArray((item as Record<string, unknown>).content),
                  ) as Record<string, unknown> | undefined;
                  if (!first) return null;
                  const content = (first.content as Array<Record<string, unknown>>).find(
                    (part) => part?.type === "output_text" && typeof part.text === "string",
                  );
                  return typeof content?.text === "string" ? content.text : null;
                } catch {
                  return null;
                }
              })();

          if (!raw) {
            lastError =
              `mymem: llm-client [${label}] empty OAuth response content from model ${config.model}`;
            log(lastError);
            errorCount++;
            return null;
          }

          const jsonStr = extractJsonFromResponse(raw);
          if (!jsonStr) {
            lastError =
              `mymem: llm-client [${label}] no JSON object found in OAuth response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
            log(lastError);
            errorCount++;
            return null;
          }

          const parsed = parseAndValidateJson<T>(jsonStr, { label, sourceLabel: "OAuth ", schema, log });
          if (!parsed.value) {
            lastError = parsed.error ?? `mymem: llm-client [${label}] OAuth JSON response validation failed`;
            log(lastError);
            errorCount++;
            return null;
          }
          return parsed.value;
        } finally {
          dispose();
        }
      } catch (err) {
        lastError =
          `mymem: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        (warnLog ?? log)(lastError);
        errorCount++;
        return null;
      } finally {
        release();
      }
    },
    getLastError(): string | null {
      return lastError;
    },
    get recentErrorCount(): number {
      return errorCount;
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  const warnLog = config.warnLog;
  if (config.auth === "oauth") {
    return createOauthClient(config, log, warnLog);
  }
  return createApiKeyClient(config, log, warnLog);
}

export { extractJsonFromResponse, repairCommonJson };
