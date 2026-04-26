/**
 * OpenClaw Extension Utilities
 *
 * Helper functions for resolving OpenClaw runtime-provided agent helpers.
 */

import type { EmbeddedPiRunner } from "./plugin-types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Resolves the embedded Pi runner injected by the current OpenClaw plugin runtime.
 */
export function resolveRuntimeEmbeddedPiRunner(api: unknown): EmbeddedPiRunner | undefined {
  const runtime = asRecord(asRecord(api)?.runtime);
  const agent = asRecord(runtime?.agent);
  const runner = agent?.runEmbeddedPiAgent;
  return typeof runner === "function" ? runner as EmbeddedPiRunner : undefined;
}
