import type { MetadataPatch } from "./store-types.js";

export const AUTO_RECALL_METADATA_FLUSH_DEBOUNCE_MS = 3_000;

type MetadataBatchStore = {
  patchMetadataBatch(
    patches: Array<{ id: string; patch: MetadataPatch }>,
    scopeFilter?: string[],
  ): Promise<number>;
};

type WarnLogger = {
  warn(message: string): void;
};

type PendingAutoRecallPatch = {
  baseInjectedCount: number;
  baseAccessCount: number;
  baseBadRecallCount: number;
  baseSuppressedUntilTurn: number;
  injectedDelta: number;
  accessDelta: number;
  badRecallDelta: number;
  lastInjectedAt: number;
  lastAccessedAt: number;
  suppressedUntilTurn: number;
  scopeFilter?: string[];
};

export type AutoRecallMetadataItem = {
  id: string;
  meta: Record<string, unknown>;
};

export type AutoRecallMetadataAccumulatorOptions = {
  store: MetadataBatchStore;
  logger: WarnLogger;
  debounceMs?: number;
};

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

function cloneScopeFilter(scopeFilter?: string[]): string[] | undefined {
  return Array.isArray(scopeFilter) ? [...scopeFilter] : undefined;
}

function scopeFilterKey(scopeFilter?: string[]): string {
  return Array.isArray(scopeFilter) ? scopeFilter.join("\0") : "__bypass__";
}

export class AutoRecallMetadataAccumulator {
  private readonly store: MetadataBatchStore;
  private readonly logger: WarnLogger;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingAutoRecallPatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AutoRecallMetadataAccumulatorOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? AUTO_RECALL_METADATA_FLUSH_DEBOUNCE_MS));
  }

  enqueue(
    items: AutoRecallMetadataItem[],
    options: {
      injectedAt: number;
      currentTurn: number;
      minRepeated: number;
      scopeFilter?: string[];
    },
  ): void {
    if (items.length === 0) return;

    for (const item of items) {
      if (!item.id) continue;

      const meta = item.meta;
      const baseInjectedCount = countValue(meta.injected_count);
      const baseAccessCount = countValue(meta.access_count);
      const baseBadRecallCount = countValue(meta.bad_recall_count);
      const baseSuppressedUntilTurn = countValue(meta.suppressed_until_turn);
      const lastConfirmedUseAt = optionalTimestamp(meta.last_confirmed_use_at);

      const existing = this.pending.get(item.id);
      const record: PendingAutoRecallPatch = existing ?? {
        baseInjectedCount,
        baseAccessCount,
        baseBadRecallCount,
        baseSuppressedUntilTurn,
        injectedDelta: 0,
        accessDelta: 0,
        badRecallDelta: 0,
        lastInjectedAt: options.injectedAt,
        lastAccessedAt: options.injectedAt,
        suppressedUntilTurn: baseSuppressedUntilTurn,
        scopeFilter: cloneScopeFilter(options.scopeFilter),
      };
      const priorInjectedAt = existing
        ? record.lastInjectedAt
        : optionalTimestamp(meta.last_injected_at);
      const staleInjected = priorInjectedAt !== undefined &&
        (lastConfirmedUseAt === undefined || lastConfirmedUseAt < priorInjectedAt);
      const badRecallDelta = staleInjected ? 1 : 0;

      record.injectedDelta += 1;
      record.accessDelta += 1;
      record.badRecallDelta += badRecallDelta;
      record.lastInjectedAt = Math.max(record.lastInjectedAt, options.injectedAt);
      record.lastAccessedAt = Math.max(record.lastAccessedAt, options.injectedAt);

      const nextBadRecallCount = record.baseBadRecallCount + record.badRecallDelta;
      if (nextBadRecallCount >= 3 && options.minRepeated > 0) {
        record.suppressedUntilTurn = Math.max(
          record.suppressedUntilTurn,
          options.currentTurn + options.minRepeated,
        );
      }

      this.pending.set(item.id, record);
    }

    this.scheduleFlush();
  }

  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pending.size === 0) return;

    const pending = new Map(this.pending);
    this.pending.clear();

    const groups = new Map<string, {
      scopeFilter?: string[];
      patches: Array<{ id: string; patch: MetadataPatch }>;
    }>();

    for (const [id, record] of pending.entries()) {
      const key = scopeFilterKey(record.scopeFilter);
      const group = groups.get(key) ?? {
        scopeFilter: cloneScopeFilter(record.scopeFilter),
        patches: [],
      };
      group.patches.push({
        id,
        patch: {
          injected_count: record.baseInjectedCount + record.injectedDelta,
          last_injected_at: record.lastInjectedAt,
          bad_recall_count: record.baseBadRecallCount + record.badRecallDelta,
          suppressed_until_turn: Math.max(record.baseSuppressedUntilTurn, record.suppressedUntilTurn),
          access_count: record.baseAccessCount + record.accessDelta,
          last_accessed_at: record.lastAccessedAt,
        },
      });
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      try {
        await this.store.patchMetadataBatch(group.patches, group.scopeFilter);
      } catch (err) {
        this.logger.warn("mymem: injection metadata batch update failed: " + String(err));
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
    this.timer.unref?.();
  }
}
