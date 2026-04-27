/**
 * Auto-Capture Utilities
 *
 * Helper functions for auto-capture session/conversation key building.
 */

export const AUTO_CAPTURE_MAP_MAX_ENTRIES = 2000;

/**
 * Builds a conversation key from channel and conversation IDs.
 */
export function buildAutoCaptureConversationKeyFromIngress(
  channelId: string | undefined,
  conversationId: string | undefined,
): string | null {
  const channel = typeof channelId === "string" ? channelId.trim() : "";
  const conversation = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!channel || !conversation) return null;
  return `${channel}:${conversation}`;
}

/**
 * Extracts the conversation portion from a sessionKey.
 * Expected format: `agent:<agentId>:<channelId>:<conversationId>`
 * where `<agentId>` does not contain colons. Returns everything after
 * the second colon as the conversation key, or null if the format
 * does not match.
 */
export function buildAutoCaptureConversationKeyFromSessionKey(sessionKey: string): string | null {
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  const match = /^agent:[^:]+:(.+)$/.exec(trimmed);
  const suffix = match?.[1]?.trim();
  return suffix || null;
}

/**
 * Checks if a session key represents an internal reflection session.
 */
export function isInternalReflectionSessionKey(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().startsWith("temp:memory-reflection");
}
