/** Maximum recursion depth for embedSingle chunking retries. */
export const MAX_EMBED_DEPTH = 3;

/** Global timeout for a single embedding operation (ms). */
export const EMBED_TIMEOUT_MS = 20_000;
/** Global cap for concurrent provider-bound embedding requests across all Embedder instances. */
export const GLOBAL_EMBED_CONCURRENCY_LIMIT = 10;

/**
 * Strictly decreasing character limit for forced truncation.
 * Each recursion level MUST reduce input by this factor to guarantee progress.
 */
export const STRICT_REDUCTION_FACTOR = 0.5; // Each retry must be at most 50% of previous

interface PendingPermit {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ConcurrencyLimiter {
  private readonly limit: number;
  private inUse = 0;
  private readonly queue: PendingPermit[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }

    if (this.inUse < this.limit) {
      this.inUse += 1;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingPermit = { resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => {
          const idx = this.queue.indexOf(pending);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseNext();
    };
  }

  private releaseNext(): void {
    while (this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) break;

      if (pending.signal?.aborted) {
        if (pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(pending.signal.reason ?? new Error("aborted"));
        continue;
      }

      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.resolve(this.makeRelease());
      return;
    }

    this.inUse = Math.max(0, this.inUse - 1);
  }
}

export const globalEmbedRequestLimiter = new ConcurrencyLimiter(GLOBAL_EMBED_CONCURRENCY_LIMIT);
