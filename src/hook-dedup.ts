/**
 * Hook Event Deduplication Utilities
 *
 * Guards against duplicate hook event processing in multi-scope environments.
 */

// WeakSet keyed by API instance — each distinct API object tracks its own initialized state.
const _hookEventDedup = new Set<string>();

/**
 * Returns true if this event was already processed (skip), false if first
 * occurrence (proceed). Automatically prunes Set when size > 200.
 */
export function dedupHookEvent(handlerName: string, event: any): boolean {
  const sk = typeof event?.sessionKey === "string" ? event.sessionKey : "?";
  const ts = event?.timestamp instanceof Date
    ? event.timestamp.getTime()
    : (typeof event?.timestamp === "number" ? event.timestamp : Date.now());
  const key = `${handlerName}:${sk}:${ts}`;
  if (_hookEventDedup.has(key)) return true; // duplicate — skip
  _hookEventDedup.add(key);
  if (_hookEventDedup.size > 200) {
    // Keep newest 100: convert to array (preserves insertion order), slice last 100, clear, re-add
    const arr = Array.from(_hookEventDedup);
    const newest100 = arr.slice(-100);
    _hookEventDedup.clear();
    for (const k of newest100) _hookEventDedup.add(k);
  }
  return false; // first occurrence — proceed
}
