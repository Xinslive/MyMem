/**
 * Configuration Utilities
 *
 * Helper functions for resolving and parsing plugin configuration values.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseAgentIdFromSessionKey } from "./scopes.js";

/**
 * Resolves environment variable references in a string.
 * Throws if the referenced environment variable is not set.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

/**
 * Parses a value as a positive integer.
 * Supports number or string input (with optional env var resolution).
 */
export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    const resolved = resolveEnvVars(s);
    const n = Number(resolved);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * Extracts the first API key from an array or single key.
 * Resolves environment variable references.
 */
export function resolveFirstApiKey(apiKey: string | string[]): string {
  const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (!key) {
    throw new Error("embedding.apiKey is empty");
  }
  return resolveEnvVars(key);
}

/**
 * Resolves an optional path with environment variable support.
 */
export function resolveOptionalPathWithEnv(
  api: Pick<OpenClawPluginApi, "resolvePath">,
  value: string | undefined,
  fallback: string,
): string {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return api.resolvePath(resolveEnvVars(raw));
}

/**
 * Resolves workspace directory from context, with fallback to default.
 */
export function resolveWorkspaceDirFromContext(
  context: Record<string, unknown> | undefined,
  defaultDir: string,
): string {
  const runtimePath = typeof context?.workspaceDir === "string" ? (context.workspaceDir as string).trim() : "";
  return runtimePath || defaultDir;
}

/**
 * Resolves the agent ID from explicit config or session key.
 */
export function resolveHookAgentId(
  explicitAgentId: string | undefined,
  sessionKey: string | undefined,
): string {
  const trimmedExplicit = explicitAgentId?.trim();
  return (trimmedExplicit && trimmedExplicit.length > 0
    ? trimmedExplicit
    : parseAgentIdFromSessionKey(sessionKey)) || "main";
}

/**
 * Resolves the source from a session key.
 * e.g., "agent:main:cli:session123" -> "cli"
 */
export function resolveSourceFromSessionKey(sessionKey: string | undefined): string {
  const trimmed = sessionKey?.trim() ?? "";
  const match = /^agent:[^:]+:([^:]+)/.exec(trimmed);
  const source = match?.[1]?.trim();
  return source || "unknown";
}

/**
 * Clamps a value within [min, max] and converts to integer.
 */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Prunes oldest entries from a Map when it exceeds maxEntries.
 */
export function pruneMapIfOver<K, V>(map: Map<K, V>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) map.delete(key);
  }
}

/**
 * Resolves LLM timeout in milliseconds from plugin config.
 */
export function resolveLlmTimeoutMs(config: { llm?: { timeoutMs?: unknown } }): number {
  return parsePositiveInt(config.llm?.timeoutMs) ?? 90000;
}
