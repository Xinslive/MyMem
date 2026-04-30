/**
 * Plugin Registration — extracted gateway maintenance logic from index.ts.
 *
 * Contains the `runGatewayMaintenance()` function that runs on `gateway_start`:
 * - Preference distillation
 * - Experience compilation
 * - Lifecycle maintenance (prune + tier)
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
import {
  runExperienceCompiler,
  shouldRunExperienceCompiler,
  recordExperienceCompilerRun,
} from "./experience-compiler.js";

/** Context object passed to extracted registration functions. */
export interface PluginRegistrationContext {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: Embedder;
  decayEngine: DecayEngine;
  tierManager: TierManager;
  smartExtractionLlmClient: LlmClient | null;
  resolvedDbPath: string;
}

/**
 * Register the `gateway_start` hook that runs periodic maintenance tasks:
 * preference distillation, experience compilation, lifecycle maintenance, and compaction.
 */
export function registerGatewayMaintenance(ctx: PluginRegistrationContext): void {
  const { api, config, store, embedder, decayEngine, tierManager, smartExtractionLlmClient, resolvedDbPath } = ctx;

  if (
    !config.memoryCompaction?.enabled &&
    !config.lifecycleMaintenance?.enabled &&
    !(config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill) &&
    !(config.experienceCompiler?.enabled && config.experienceCompiler?.gatewayBackfill)
  ) {
    return;
  }

  api.on("gateway_start", () => {
    const compactionStateFile = join(dirname(resolvedDbPath), ".compaction-state.json");
    const lifecycleStateFile = join(dirname(resolvedDbPath), ".lifecycle-maintenance-state.json");
    const distillerStateFile = join(dirname(resolvedDbPath), ".preference-distiller-state.json");
    const compilerStateFile = join(dirname(resolvedDbPath), ".experience-compiler-state.json");

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

    Promise.all([
      config.preferenceDistiller?.enabled && config.preferenceDistiller?.gatewayBackfill
        ? shouldRunPreferenceDistiller(distillerStateFile, config.preferenceDistiller.cooldownHours ?? 4)
        : Promise.resolve(false),
      config.experienceCompiler?.enabled && config.experienceCompiler?.gatewayBackfill
        ? shouldRunExperienceCompiler(compilerStateFile, config.experienceCompiler.cooldownHours ?? 4)
        : Promise.resolve(false),
      lifecycleCfg.enabled ? shouldRunLifecycleMaintenance(lifecycleStateFile, lifecycleCfg.cooldownHours) : Promise.resolve(false),
      compactionCfg ? shouldRunCompaction(compactionStateFile, compactionCfg.cooldownHours) : Promise.resolve(false),
    ])
      .then(async ([runDistiller, runCompiler, runLifecycle, runCompact]) => {
        let distillResult: Awaited<ReturnType<typeof runPreferenceDistiller>> | null = null;
        let compilerResult: Awaited<ReturnType<typeof runExperienceCompiler>> | null = null;
        let pruneResult: Awaited<ReturnType<typeof runLifecycleMaintenance>> | null = null;
        let tierResult: Awaited<ReturnType<typeof runLifecycleMaintenance>> | null = null;
        let compactionResult: Awaited<ReturnType<typeof runCompaction>> | null = null;

        if (runDistiller) {
          distillResult = await runPreferenceDistiller(
            { store, embedder, logger: api.logger },
            config.preferenceDistiller,
          );
          await recordPreferenceDistillerRun(distillerStateFile);
        }

        if (runCompiler) {
          compilerResult = await runExperienceCompiler(
            { store, embedder, logger: api.logger },
            config.experienceCompiler,
          );
          await recordExperienceCompilerRun(compilerStateFile);
        }

        if (runLifecycle) {
          pruneResult = await runLifecycleMaintenance(
            { store, decayEngine, tierManager, logger: api.logger },
            { ...lifecycleCfg, phase: "prune" },
          );
        }

        if (runCompact && compactionCfg) {
          await recordCompactionRun(compactionStateFile);
          compactionResult = await runCompaction(
            store as never,
            embedder,
            compactionCfg,
            undefined,
            api.logger,
            compactionLifecycle,
            smartExtractionLlmClient ?? undefined,
          );
        }

        if (runLifecycle) {
          tierResult = await runLifecycleMaintenance(
            { store, decayEngine, tierManager, logger: api.logger },
            { ...lifecycleCfg, phase: "tier" },
          );
          await recordLifecycleMaintenanceRun(lifecycleStateFile);
        }

        if (distillResult || compilerResult || pruneResult || compactionResult || tierResult) {
          api.logger.info(
            `memory-maintenance [auto]: ` +
            `distilled=${distillResult?.created ?? 0}/${distillResult?.updated ?? 0} ` +
            `compiled=${compilerResult?.created ?? 0}/${compilerResult?.updated ?? 0} ` +
            `lifecycleScanned=${(pruneResult?.scanned ?? 0) + (tierResult?.scanned ?? 0)} ` +
            `compactionScanned=${compactionResult?.scanned ?? 0} ` +
            `clusters=${compactionResult?.clustersFound ?? 0} ` +
            `created=${compactionResult?.memoriesCreated ?? 0} ` +
            `deleted=${(pruneResult?.deleted ?? 0) + (compactionResult?.memoriesDeleted ?? 0)} ` +
            `deleteReasons=${JSON.stringify(pruneResult?.deleteReasons ?? {})} ` +
            `llmRefined=${compactionResult?.llmRefined ?? 0} ` +
            `fallbackMerged=${compactionResult?.fallbackMerged ?? 0} ` +
            `failedClusters=${compactionResult?.failedClusters ?? 0} ` +
            `archived=${pruneResult?.archived ?? 0} ` +
            `promoted=${tierResult?.promoted ?? 0} demoted=${tierResult?.demoted ?? 0}`,
          );
        }
      })
      .catch((err) => {
        api.logger.warn(`memory-maintenance [auto]: failed: ${String(err)}`);
      });
  });
}
