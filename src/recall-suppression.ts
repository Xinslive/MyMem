import { clampInt } from "./utils.js";

export const DEFAULT_RECALL_SUPPRESSION_TTL_MS = 30 * 60_000;

type MetadataLike = Record<string, unknown>;

function countValue(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function optionalTimestamp(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function hasActiveRecallSuppression(
  metadata: MetadataLike,
  now = Date.now(),
): boolean {
  const suppressedUntilAt = optionalTimestamp(metadata.suppressed_until_at);
  if (!suppressedUntilAt || suppressedUntilAt < now) return false;
  return Boolean(optionalString(metadata.suppressed_session_key)) &&
    countValue(metadata.suppressed_until_turn) > 0;
}

export function isRecallSuppressedForSession(
  metadata: MetadataLike,
  params: {
    sessionKey: string;
    currentTurn: number;
    now?: number;
  },
): boolean {
  if (!hasActiveRecallSuppression(metadata, params.now ?? Date.now())) return false;
  if (optionalString(metadata.suppressed_session_key) !== params.sessionKey.trim()) return false;
  return countValue(params.currentTurn) <= countValue(metadata.suppressed_until_turn);
}

export function buildRecallSuppressionPatch(params: {
  metadata: MetadataLike;
  sessionKey: string;
  currentTurn: number;
  suppressTurns: number;
  now?: number;
}): MetadataLike {
  const now = params.now ?? Date.now();
  const sessionKey = params.sessionKey.trim();
  const suppressTurns = clampInt(params.suppressTurns, 1, 100);
  const targetTurn = countValue(params.currentTurn) + suppressTurns;
  const existingTurn = hasActiveRecallSuppression(params.metadata, now) &&
    optionalString(params.metadata.suppressed_session_key) === sessionKey
    ? countValue(params.metadata.suppressed_until_turn)
    : 0;

  return {
    suppressed_until_turn: Math.max(existingTurn, targetTurn),
    suppressed_session_key: sessionKey,
    suppressed_until_at: now + DEFAULT_RECALL_SUPPRESSION_TTL_MS,
  };
}
