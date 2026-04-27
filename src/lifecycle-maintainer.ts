import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DecayEngine } from "./decay-engine.js";
import type { TierManager } from "./tier-manager.js";
import type { Logger } from "./logger.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import {
  getDecayableFromEntry,
  isMemoryExpired,
  parseSmartMetadata,
  stringifySmartMetadata,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { inferGovernanceRuleFromMemory, rulesConflict } from "./governance-rules.js";

export interface LifecycleMaintenanceConfig {
  enabled: boolean;
  cooldownHours: number;
  maxMemoriesToScan: number;
  archiveThreshold: number;
  dryRun: boolean;
  deleteMode: "delete" | "archive";
  deleteReasons: string[];
  hardDeleteReasons: string[];
  phase: "all" | "prune" | "tier";
}

export interface LifecycleMaintenanceResult {
  scanned: number;
  archived: number;
  deleted: number;
  deleteReasons: Record<string, number>;
  promoted: number;
  demoted: number;
  skipped: number;
  dryRun: boolean;
}

export interface LifecycleMaintenanceDeps {
  store: Pick<MemoryStore, "list" | "update" | "delete">;
  decayEngine: DecayEngine;
  tierManager: TierManager;
  logger?: Pick<Logger, "debug" | "info" | "warn">;
}

type RowContext = {
  entry: MemoryEntry;
  meta: SmartMemoryMetadata;
  score: { composite: number };
};

const DEFAULT_CONFIG: LifecycleMaintenanceConfig = {
  enabled: true,
  cooldownHours: 6,
  maxMemoriesToScan: 300,
  archiveThreshold: 0.15,
  dryRun: false,
  deleteMode: "archive",
  deleteReasons: ["expired", "superseded", "bad_recall", "stale_unaccessed"],
  hardDeleteReasons: ["duplicate_cluster_source", "noise", "superseded_fragment"],
  phase: "all",
};

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function normalizeConfig(config?: Partial<LifecycleMaintenanceConfig>): LifecycleMaintenanceConfig {
  const deleteReasons = Array.isArray(config?.deleteReasons)
    ? config.deleteReasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : DEFAULT_CONFIG.deleteReasons;
  const hardDeleteReasons = Array.isArray(config?.hardDeleteReasons)
    ? config.hardDeleteReasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : DEFAULT_CONFIG.hardDeleteReasons;
  return {
    enabled: config?.enabled !== false,
    cooldownHours: Math.max(1, Math.floor(config?.cooldownHours ?? DEFAULT_CONFIG.cooldownHours)),
    maxMemoriesToScan: Math.max(1, Math.floor(config?.maxMemoriesToScan ?? DEFAULT_CONFIG.maxMemoriesToScan)),
    archiveThreshold: clamp01(config?.archiveThreshold ?? DEFAULT_CONFIG.archiveThreshold, DEFAULT_CONFIG.archiveThreshold),
    dryRun: config?.dryRun === true,
    deleteMode: config?.deleteMode === "delete" ? "delete" : "archive",
    deleteReasons,
    hardDeleteReasons,
    phase: config?.phase === "prune" || config?.phase === "tier" ? config.phase : "all",
  };
}

function shouldSkip(meta: SmartMemoryMetadata): boolean {
  return meta.state === "archived" || meta.memory_layer === "archive" || meta.source === "session-summary";
}

function archiveReason(meta: SmartMemoryMetadata, composite: number, archiveThreshold: number): string | null {
  if (isMemoryExpired(meta)) return "expired";
  if (meta.superseded_by) return meta.compacted === true ? "superseded_fragment" : "superseded";
  if (meta.bad_recall_count >= 3 && composite < Math.max(archiveThreshold, 0.25)) return "bad_recall";
  if (meta.compacted === true && meta.source_count === 0) return "duplicate_cluster_source";
  if (meta.noise === true) return "noise";
  if (composite < archiveThreshold && meta.tier === "peripheral" && meta.access_count === 0) return "stale_unaccessed";
  return null;
}

function contradictionKey(entry: MemoryEntry, meta: SmartMemoryMetadata): string | null {
  if (meta.memory_category === "preferences" || meta.memory_category === "entities") {
    const factKey = typeof meta.fact_key === "string" ? meta.fact_key.trim() : "";
    if (factKey) return factKey;
  }
  if (meta.memory_category === "patterns") {
    const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || entry.text, "patterns");
    if (inferred) return inferred.topic;
    const canonical = typeof meta.canonical_id === "string" ? meta.canonical_id.trim() : "";
    if (canonical) return canonical;
  }
  if (meta.memory_category === "preferences") {
    const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || entry.text, "preferences");
    if (inferred) return inferred.topic;
    const canonical = typeof meta.canonical_id === "string" ? meta.canonical_id.trim() : "";
    if (canonical) return canonical;
  }
  return null;
}

function scopedContradictionKey(entry: MemoryEntry, meta: SmartMemoryMetadata): string | null {
  const key = contradictionKey(entry, meta);
  if (!key) return null;
  return `${entry.scope || "global"}\0${key}`;
}

function buildContradictionPlans(rows: RowContext[]): Map<string, { reason: string; newerId: string }> {
  const eligible = rows.filter(({ meta }) =>
    meta.state !== "archived" &&
    (meta.memory_category === "preferences" || meta.memory_category === "patterns" || meta.memory_category === "entities"),
  );

  const groups = new Map<string, RowContext[]>();
  for (const row of eligible) {
    const key = scopedContradictionKey(row.entry, row.meta);
    if (!key) continue;
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  const plans = new Map<string, { reason: string; newerId: string }>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => {
      if (b.entry.timestamp !== a.entry.timestamp) return b.entry.timestamp - a.entry.timestamp;
      return Number(b.meta.confidence ?? 0.7) - Number(a.meta.confidence ?? 0.7);
    });

    const newest = sorted[0];
    const newestRule = newest.meta.memory_category === "patterns" || newest.meta.memory_category === "preferences"
      ? inferGovernanceRuleFromMemory(newest.meta.l0_abstract || newest.entry.text, newest.meta.memory_category)
      : null;

    for (const older of sorted.slice(1)) {
      if (older.meta.superseded_by) continue;
      const olderConfidence = Number(older.meta.confidence ?? 0.7);
      const newerConfidence = Number(newest.meta.confidence ?? 0.7);
      let shouldArchive = false;

      if (
        (older.meta.memory_category === "preferences" || older.meta.memory_category === "entities") &&
        newest.meta.fact_key &&
        older.meta.fact_key &&
        newest.meta.fact_key === older.meta.fact_key &&
        newest.meta.l0_abstract !== older.meta.l0_abstract &&
        newerConfidence >= olderConfidence
      ) {
        shouldArchive = true;
      } else if (older.meta.memory_category === "patterns" || older.meta.memory_category === "preferences") {
        const olderRule = inferGovernanceRuleFromMemory(older.meta.l0_abstract || older.entry.text, older.meta.memory_category);
        if (rulesConflict(newestRule, olderRule) && newerConfidence >= olderConfidence) {
          shouldArchive = true;
        }
      } else if (
        typeof newest.meta.canonical_id === "string" &&
        typeof older.meta.canonical_id === "string" &&
        newest.meta.canonical_id === older.meta.canonical_id &&
        newest.meta.l0_abstract !== older.meta.l0_abstract &&
        newerConfidence >= olderConfidence
      ) {
        shouldArchive = true;
      }

      if (shouldArchive) {
        plans.set(older.entry.id, { reason: "contradiction_newer_version", newerId: newest.entry.id });
      }
    }
  }

  return plans;
}

function shouldHardDelete(cfg: LifecycleMaintenanceConfig, reason: string): boolean {
  return cfg.hardDeleteReasons.includes(reason) ||
    (cfg.deleteMode === "delete" && cfg.deleteReasons.includes(reason));
}

function isDemotion(from: string, to: string): boolean {
  const rank: Record<string, number> = { peripheral: 0, working: 1, core: 2 };
  return (rank[to] ?? 0) < (rank[from] ?? 0);
}

export async function shouldRunLifecycleMaintenance(
  stateFile: string,
  cooldownHours: number,
): Promise<boolean> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const state = JSON.parse(raw) as { lastRunAt?: number };
    if (typeof state.lastRunAt === "number") {
      return Date.now() - state.lastRunAt >= cooldownHours * 60 * 60 * 1000;
    }
  } catch {
    // Missing or malformed state means this is the first run.
  }
  return true;
}

export async function recordLifecycleMaintenanceRun(stateFile: string): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}

export async function runLifecycleMaintenance(
  deps: LifecycleMaintenanceDeps,
  config?: Partial<LifecycleMaintenanceConfig>,
): Promise<LifecycleMaintenanceResult> {
  const cfg = normalizeConfig(config);
  const result: LifecycleMaintenanceResult = {
    scanned: 0,
    archived: 0,
    deleted: 0,
    deleteReasons: {},
    promoted: 0,
    demoted: 0,
    skipped: 0,
    dryRun: cfg.dryRun,
  };

  if (!cfg.enabled) return result;

  const rawRows = await deps.store.list(undefined, undefined, cfg.maxMemoriesToScan, 0);
  result.scanned = rawRows.length;
  const now = Date.now();

  const rows: RowContext[] = rawRows.map((entry) => {
    const { memory, meta } = getDecayableFromEntry(entry);
    const score = deps.decayEngine.score(memory, now);
    return { entry, meta, score };
  });

  const prunePlans = new Map<string, { reason: string; newerId?: string }>();
  if (cfg.phase !== "tier") {
    for (const row of rows) {
      if (shouldSkip(row.meta)) continue;
      const reason = archiveReason(row.meta, row.score.composite, cfg.archiveThreshold);
      if (reason) prunePlans.set(row.entry.id, { reason });
    }
    for (const [id, plan] of buildContradictionPlans(rows).entries()) {
      prunePlans.set(id, plan);
    }
  }

  for (const row of rows) {
    if (shouldSkip(row.meta)) {
      result.skipped++;
      continue;
    }

    const plan = prunePlans.get(row.entry.id);
    if (plan && cfg.phase !== "tier") {
      if (!cfg.dryRun) {
        if (shouldHardDelete(cfg, plan.reason)) {
          const deleted = await deps.store.delete(row.entry.id);
          if (deleted) {
            result.deleted++;
            result.deleteReasons[plan.reason] = (result.deleteReasons[plan.reason] ?? 0) + 1;
          }
        } else {
          row.meta.state = "archived";
          row.meta.memory_layer = "archive";
          row.meta.archived_at = now;
          row.meta.archive_reason = plan.reason;
          row.meta.prune_reason = plan.reason;
          row.meta.lifecycle_score = row.score.composite;
          if (plan.newerId) {
            row.meta.invalidated_at = now;
            row.meta.superseded_by = plan.newerId;
          }
          await deps.store.update(row.entry.id, { metadata: stringifySmartMetadata(row.meta) });
          result.archived++;
        }
      } else if (shouldHardDelete(cfg, plan.reason)) {
        result.deleted++;
        result.deleteReasons[plan.reason] = (result.deleteReasons[plan.reason] ?? 0) + 1;
      } else {
        result.archived++;
      }
      continue;
    }

    if (cfg.phase === "prune") continue;

    const { memory } = getDecayableFromEntry(row.entry);
    const transition = deps.tierManager.evaluate(memory, deps.decayEngine.score(memory, now), now);
    if (!transition) continue;

    if (!cfg.dryRun) {
      row.meta.tier = transition.toTier;
      row.meta.tier_updated_at = now;
      row.meta.tier_update_reason = transition.reason;
      row.meta.lifecycle_score = row.score.composite;
      await deps.store.update(row.entry.id, { metadata: stringifySmartMetadata(row.meta) });
    }

    if (isDemotion(transition.fromTier, transition.toTier)) {
      result.demoted++;
    } else {
      result.promoted++;
    }
  }

  deps.logger?.info?.(
    `memory-lifecycle: scanned=${result.scanned} archived=${result.archived} deleted=${result.deleted} ` +
      `deleteReasons=${JSON.stringify(result.deleteReasons)} promoted=${result.promoted} ` +
      `demoted=${result.demoted} skipped=${result.skipped} dryRun=${result.dryRun}`,
  );

  return result;
}
