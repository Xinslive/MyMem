/**
 * Plugin Registration — extracted gateway maintenance logic from index.ts.
 *
 * Contains the `runGatewayMaintenance()` function that runs on `gateway_start`:
 * - Preference distillation
 * - Lifecycle maintenance
 * - Memory compaction
 */

import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./plugin-types.js";
import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { DecayEngine } from "./decay-engine.js";
import type { TierManager } from "./tier-manager.js";
import type { LlmClient } from "./llm-client.js";
import {
  runCompaction,
  shouldRunCompaction,
  recordCompactionRun,
  type CompactionConfig,
  type CompactorLifecycle,
} from "./memory-compactor.js";
import {
  runLifecycleMaintenance,
  shouldRunLifecycleMaintenance,
  recordLifecycleMaintenanceRun,
} from "./lifecycle-maintainer.js";
import {
  runPreferenceDistiller,
  shouldRunPreferenceDistiller,
  recordPreferenceDistillerRun,
} from "./preference-distiller.js";

/** Context object passed to extracted registration functions. */
export interface PluginRegistrationContext {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  reflectionStore: MemoryStore;
  embedder: Embedder;
  decayEngine: DecayEngine;
  tierManager: TierManager;
  smartExtractionLlmClient: LlmClient | null;
  resolvedDbPath: string;
}

type GatewayMaintenanceDeps = {
  runPreferenceDistiller: typeof runPreferenceDistiller;
  shouldRunPreferenceDistiller: typeof shouldRunPreferenceDistiller;
  recordPreferenceDistillerRun: typeof recordPreferenceDistillerRun;
  runLifecycleMaintenance: typeof runLifecycleMaintenance;
  shouldRunLifecycleMaintenance: typeof shouldRunLifecycleMaintenance;
  recordLifecycleMaintenanceRun: typeof recordLifecycleMaintenanceRun;
  runCompaction: typeof runCompaction;
  shouldRunCompaction: typeof shouldRunCompaction;
  recordCompactionRun: typeof recordCompactionRun;
};

const defaultGatewayMaintenanceDeps: GatewayMaintenanceDeps = {
  runPreferenceDistiller,
  shouldRunPreferenceDistiller,
  recordPreferenceDistillerRun,
  runLifecycleMaintenance,
  shouldRunLifecycleMaintenance,
  recordLifecycleMaintenanceRun,
  runCompaction,
  shouldRunCompaction,
  recordCompactionRun,
};

async function runGatewayMaintenanceOnce(
  ctx: PluginRegistrationContext,
  deps: GatewayMaintenanceDeps = defaultGatewayMaintenanceDeps,
): Promise<void> {
  const { api, config, store, embedder, decayEngine, tierManager, smartExtractionLlmClient, resolvedDbPath } = ctx;
  const compactionStateFile = join(dirname(resolvedDbPath), ".compaction-state.json");
  const lifecycleStateFile = join(dirname(resolvedDbPath), ".lifecycle-maintenance-state.json");
  const distillerStateFile = join(dirname(resolvedDbPath), ".preference-distiller-state.json");

  const compactionCfg: CompactionConfig | null = config.memoryCompaction?.enabled ? {
    enabled: true,
    minAgeDays: config.memoryCompaction!.minAgeDays ?? 7,
    similarityThreshold: config.memoryCompaction!.similarityThreshold ?? 0.88,
    minClusterSize: config.memoryCompaction!.minClusterSize ?? 2,
    maxMemoriesToScan: config.memoryCompaction!.maxMemoriesToScan ?? 200,
    dryRun: config.memoryCompaction!.dryRun === true,
    cooldownHours: config.memoryCompaction!.cooldownHours ?? 4,
    mergeMode: config.memoryCompaction!.mergeMode ?? "llm",
    deleteSourceMemories: config.memoryCompaction!.deleteSourceMemories !== false,
    maxLlmClustersPerRun: config.memoryCompaction!.maxLlmClustersPerRun ?? 10,
  } : null;

  const lifecycleCfg = {
    enabled: config.lifecycleMaintenance?.enabled === true,
    cooldownHours: config.lifecycleMaintenance?.cooldownHours ?? 4,
    maxMemoriesToScan: config.lifecycleMaintenance?.maxMemoriesToScan ?? 500,
    archiveThreshold: config.lifecycleMaintenance?.archiveThreshold ?? 0.15,
    dryRun: config.lifecycleMaintenance?.dryRun === true,
    deleteMode: config.lifecycleMaintenance?.deleteMode ?? "archive",
    deleteReasons: config.lifecycleMaintenance?.deleteReasons ?? ["expired", "superseded", "bad_recall", "stale_unaccessed"],
    hardDeleteReasons: config.lifecycleMaintenance?.hardDeleteReasons ?? ["duplicate_cluster_source", "noise", "superseded_fragment"],
  };

  const compactionLifecycle: CompactorLifecycle = {
    store: {
      getById: store.getById.bind(store),
      update: async (entry) => {
        await store.update(entry.id, {
          text: entry.text,
          vector: entry.vector,
          importance: entry.importance,
          category: entry.category,
          metadata: entry.metadata,
        });
      },
    },
  };

  const [runDistiller, runLifecycle, runCompact] = await Promise.all([
    config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill
      ? deps.shouldRunPreferenceDistiller(distillerStateFile, config.preferenceDistiller.cooldownHours ?? 4)
      : Promise.resolve(false),
    lifecycleCfg.enabled ? deps.shouldRunLifecycleMaintenance(lifecycleStateFile, lifecycleCfg.cooldownHours) : Promise.resolve(false),
    compactionCfg ? deps.shouldRunCompaction(compactionStateFile, compactionCfg.cooldownHours) : Promise.resolve(false),
  ]);

  let distillResult: Awaited<ReturnType<typeof runPreferenceDistiller>> | null = null;
  let lifecycleResult: Awaited<ReturnType<typeof runLifecycleMaintenance>> | null = null;
  let compactionResult: Awaited<ReturnType<typeof runCompaction>> | null = null;

  if (runDistiller) {
    distillResult = await deps.runPreferenceDistiller(
      { store, embedder, logger: api.logger },
      config.preferenceDistiller,
    );
    await deps.recordPreferenceDistillerRun(distillerStateFile);
  }

  if (runLifecycle) {
    lifecycleResult = await deps.runLifecycleMaintenance(
      { store, decayEngine, tierManager, logger: api.logger },
      { ...lifecycleCfg, phase: "all" },
    );
    await deps.recordLifecycleMaintenanceRun(lifecycleStateFile);
  }

  if (runCompact && compactionCfg) {
    compactionResult = await deps.runCompaction(
      store as never,
      embedder,
      compactionCfg,
      undefined,
      api.logger,
      compactionLifecycle,
      smartExtractionLlmClient ?? undefined,
    );
    await deps.recordCompactionRun(compactionStateFile);
  }

  if (distillResult || lifecycleResult || compactionResult) {
    api.logger.info(
      `memory-maintenance [auto]: ` +
      `distilled=${distillResult?.created ?? 0}/${distillResult?.updated ?? 0} ` +
      `lifecycleScanned=${lifecycleResult?.scanned ?? 0} ` +
      `compactionScanned=${compactionResult?.scanned ?? 0} ` +
      `clusters=${compactionResult?.clustersFound ?? 0} ` +
      `created=${compactionResult?.memoriesCreated ?? 0} ` +
      `deleted=${(lifecycleResult?.deleted ?? 0) + (compactionResult?.memoriesDeleted ?? 0)} ` +
      `deleteReasons=${JSON.stringify(lifecycleResult?.deleteReasons ?? {})} ` +
      `llmRefined=${compactionResult?.llmRefined ?? 0} ` +
      `fallbackMerged=${compactionResult?.fallbackMerged ?? 0} ` +
      `failedClusters=${compactionResult?.failedClusters ?? 0} ` +
      `archived=${lifecycleResult?.archived ?? 0} ` +
      `promoted=${lifecycleResult?.promoted ?? 0} demoted=${lifecycleResult?.demoted ?? 0}`,
    );
  }
}

/**
 * Register the `gateway_start` hook that runs periodic maintenance tasks:
 * preference distillation, lifecycle maintenance, and compaction.
 */
export function registerGatewayMaintenance(ctx: PluginRegistrationContext): void {
  const { api, config } = ctx;

  if (
    !config.memoryCompaction?.enabled &&
    !config.lifecycleMaintenance?.enabled &&
    !(config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill)
  ) {
    return;
  }

  api.on("gateway_start", () => {
    runGatewayMaintenanceOnce(ctx)
      .catch((err) => {
        api.logger.warn(`memory-maintenance [auto]: failed: ${String(err)}`);
      });
  });
}

export const __test__ = {
  runGatewayMaintenanceOnce,
};
