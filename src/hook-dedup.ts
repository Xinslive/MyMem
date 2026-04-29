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
export function dedupHookEvent(handlerName: string, event: any): boolean {
  const sk = typeof event?.sessionKey === "string" ? event.sessionKey : "?";
  const ts = event?.timestamp instanceof Date
    ? event.timestamp.getTime()
    : (typeof event?.timestamp === "number" ? event.timestamp : Date.now());
  const key = `${handlerName}:${sk}:${ts}`;
  const now = Date.now();

  if (_hookEventDedup.has(key)) return true; // duplicate — skip
  _hookEventDedup.set(key, now);

  if (_hookEventDedup.size > DEDUP_MAX_SIZE) {
    // Prune expired entries first
    for (const [k, entryTs] of _hookEventDedup) {
      if (now - entryTs > DEDUP_TTL_MS) _hookEventDedup.delete(k);
    }
    // If still over limit after TTL pruning, remove oldest entries
    if (_hookEventDedup.size > DEDUP_MAX_SIZE) {
      const entries = [..._hookEventDedup.entries()].sort((a, b) => a[1] - b[1]);
      const removeCount = _hookEventDedup.size - Math.floor(DEDUP_MAX_SIZE / 2);
      for (let i = 0; i < removeCount; i++) {
        _hookEventDedup.delete(entries[i][0]);
      }
    }
  }
  return false; // first occurrence — proceed
}
