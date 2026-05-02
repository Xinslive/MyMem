/**
 * Hook Event Deduplication Utilities
 *
 * Guards against duplicate hook event processing in multi-scope environments.
 * Uses a TTL-based Map for automatic expiry of stale entries.
 */

const DEDUP_TTL_MS = 60_000; // 60s TTL per entry
const DEDUP_MAX_SIZE = 200;

const _hookEventDedup = new Map<string, number>(); // key → timestamp

/**
 * Returns true if this event was already processed (skip), false if first
 * occurrence (proceed). Automatically prunes expired entries when size > 200.
 */
type HookDedupEvent = {
  sessionKey?: unknown;
  timestamp?: unknown;
};

export function dedupHookEvent(handlerName: string, event: HookDedupEvent): boolean {
  const sk = typeof event.sessionKey === "string" ? event.sessionKey : "?";
  const ts = event.timestamp instanceof Date
    ? event.timestamp.getTime()
    : (typeof event.timestamp === "number" ? event.timestamp : Date.now());
  const key = `${handlerName}:${sk}:${ts}`;
  const now = Date.now();

  if (_hookEventDedup.has(key)) return true; // duplicate — skip
  _hookEventDedup.set(key, now);

  if (_hookEventDedup.size > DEDUP_MAX_SIZE) {
    // Prune expired entries first
    for (const [k, entryTs] of _hookEventDedup) {
      if (now - entryTs > DEDUP_TTL_MS) _hookEventDedup.delete(k);
    }
    // If still over limit, evict oldest half by insertion order (O(n), no sort)
    if (_hookEventDedup.size > DEDUP_MAX_SIZE) {
      const removeCount = _hookEventDedup.size - Math.floor(DEDUP_MAX_SIZE / 2);
      const keys = _hookEventDedup.keys();
      for (let i = 0; i < removeCount; i++) {
        const k = keys.next().value;
        if (k !== undefined) _hookEventDedup.delete(k);
      }
    }
  }
  return false; // first occurrence — proceed
}
