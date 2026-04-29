interface CacheEntry {
  vector: number[];
  createdAt: number;
}

/** Threshold below which the raw string is used as cache key (avoids hashing). */
const SHORT_KEY_THRESHOLD = 200;

/**
 * FNV-1a 32-bit hash — fast non-cryptographic hash for cache keys.
 * ~10x faster than SHA-256 for typical embedding text lengths.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // Convert to unsigned 32-bit hex, zero-padded to 8 chars
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  /** Remove all expired entries. Called on every set() when cache is near capacity. */
  private _evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(k);
      }
    }
  }

  key(text: string, task?: string): string {
    const composite = `${task || ""}:${text}`;
    // Short text: use raw string as key (no hash overhead)
    if (composite.length <= SHORT_KEY_THRESHOLD) return composite;
    // Long text: fast FNV-1a hash
    return fnv1a(composite);
  }

  get(text: string, task?: string): number[] | undefined {
    const k = this.key(text, task);
    const entry = this.cache.get(k);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const k = this.key(text, task);
    if (this.cache.has(k)) {
      this.cache.delete(k);
    }
    // When cache is full, run TTL eviction first (removes expired + oldest).
    // This prevents unbounded growth from stale entries while keeping writes O(1).
    if (this.cache.size >= this.maxSize) {
      this._evictExpired();
      // If eviction didn't free enough slots, evict the single oldest LRU entry.
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get size(): number { return this.cache.size; }
  get stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}
