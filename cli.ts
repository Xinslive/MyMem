/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLanceDB, type MemoryEntry, type MemoryStore } from "./src/store.js";
import {
  buildSmartMetadata,
  parseSmartMetadata,
  reverseMapLegacyCategory,
  stringifySmartMetadata,
} from "./src/smart-metadata.js";
import { createRetriever, type MemoryRetriever } from "./src/retriever.js";
import type { MemoryScopeManager } from "./src/scopes.js";
import type { MemoryMigrator } from "./src/migrate.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";
import type { LlmClient } from "./src/llm-client.js";
import {
  explainMemoryRetrieval,
  formatRetrievalExplainText,
} from "./src/retrieval-explain.js";
import {
  formatDashboardUnlockUrl,
  startMemoryDashboardServer,
} from "./src/dashboard-server.js";
import {
  normalizeCategory,
  type MemoryCategory,
} from "./src/memory-categories.js";
import {
  filterEntriesByMemoryCategory,
  filterResultsByMemoryCategory,
  toMemoryCategory,
} from "./src/tools-shared.js";
import { getDisplayCategoryTag } from "./src/reflection-metadata.js";
import { runImportMarkdown } from "./src/cli/import-markdown.js";
import { registerOauthCommands, type OauthCLIContext } from "./src/cli/oauth.js";
import { sanitizeMemoryWriteText } from "./src/memory-write-sanitizer.js";

export { runImportMarkdown } from "./src/cli/import-markdown.js";

/**
 * Ensure metadata string has memory_category (new-format) or inject it.
 * Prevents CLI imports from creating legacy-format entries.
 */
function buildSafeMetadata(
  raw: string,
  entry: { text: string; category: MemoryEntry["category"]; importance: number },
): string {
  const parsed = parseSmartMetadata(raw, entry);
  return stringifySmartMetadata({
    ...parsed,
    memory_category: reverseMapLegacyCategory(entry.category, entry.text),
    source: parsed.source === "legacy" ? "manual" : parsed.source,
    state: parsed.state ?? "confirmed",
  });
}

// ============================================================================
// Types
// ============================================================================

interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  migrator: MemoryMigrator;
  embedder?: import("./src/embedder.js").Embedder;
  llmClient?: LlmClient;
  pluginId?: string;
  pluginConfig?: Record<string, unknown>;
  oauthTestHooks?: OauthCLIContext["oauthTestHooks"];
}

// ============================================================================
// Utility Functions
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = String(memory.text || "");
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}

function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

function formatRetrievalDiagnosticsLines(diagnostics: {
  source?: string;
  originalQuery: string;
  bm25Query: string | null;
  queryExpanded: boolean;
  vectorResultCount: number;
  bm25ResultCount: number;
  fusedResultCount: number;
  finalResultCount: number;
  stageCounts: {
    afterMinScore: number;
    rerankInput: number;
    afterRerank: number;
    afterHardMinScore: number;
    afterNoiseFilter: number;
    afterDiversity: number;
  };
  dropSummary: Array<{ stage: string; dropped: number; before: number; after: number }>;
  failureStage?: string;
  errorMessage?: string;
}): string[] {
  const topDrops =
    diagnostics.dropSummary.length > 0
      ? diagnostics.dropSummary
          .slice(0, 3)
          .map(
            (drop) => `${drop.stage} -${drop.dropped} (${drop.before}->${drop.after})`,
          )
          .join(", ")
      : "none";

  const lines = [
    "Retrieval diagnostics:",
    `  • Source: ${diagnostics.source ?? "unknown"}`,
    `  • Original query: ${diagnostics.originalQuery}`,
    `  • BM25 query: ${diagnostics.bm25Query ?? "(disabled)"}`,
    `  • Query expanded: ${diagnostics.queryExpanded ? "Yes" : "No"}`,
    `  • Counts: vector=${diagnostics.vectorResultCount}, bm25=${diagnostics.bm25ResultCount}, fused=${diagnostics.fusedResultCount}, final=${diagnostics.finalResultCount}`,
    `  • Stages: min=${diagnostics.stageCounts.afterMinScore}, rerankIn=${diagnostics.stageCounts.rerankInput}, rerank=${diagnostics.stageCounts.afterRerank}, hard=${diagnostics.stageCounts.afterHardMinScore}, noise=${diagnostics.stageCounts.afterNoiseFilter}, diversity=${diagnostics.stageCounts.afterDiversity}`,
    `  • Drops: ${topDrops}`,
  ];

  if (diagnostics.failureStage) {
    lines.push(`  • Failure stage: ${diagnostics.failureStage}`);
  }
  if (diagnostics.errorMessage) {
    lines.push(`  • Error: ${diagnostics.errorMessage}`);
  }

  return lines;
}

function buildSearchErrorPayload(
  error: unknown,
  diagnostics: unknown,
  includeDiagnostics: boolean,
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: "search_failed",
      message,
    },
    ...(includeDiagnostics && diagnostics ? { diagnostics } : {}),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// CLI Command Implementations
// ============================================================================

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  let lastSearchDiagnostics: ReturnType<MemoryRetriever["getLastDiagnostics"]> =
    null;

  const captureSearchDiagnostics = (
    retriever: Pick<MemoryRetriever, "getLastDiagnostics">,
  ) => {
    lastSearchDiagnostics =
      typeof retriever.getLastDiagnostics === "function"
        ? retriever.getLastDiagnostics()
        : null;
  };

  const getSearchRetriever = (): MemoryRetriever => {
    if (!context.embedder) {
      return context.retriever;
    }
    return createRetriever(context.store, context.embedder, context.retriever.getConfig());
  };

  const runSearch = async (
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ) => {
    if (category && !toMemoryCategory(category)) {
      throw new Error(`Invalid memory category: ${category}. Use one of: profile, preferences, entities, events, cases, patterns.`);
    }
    lastSearchDiagnostics = null;
    const retriever = getSearchRetriever();
    let results;
    try {
      results = await retriever.retrieve({
        query,
        limit: category ? limit * 4 : limit,
        scopeFilter,
        source: "auto-recall",
      });
      results = filterResultsByMemoryCategory(results, category).slice(0, limit);
      captureSearchDiagnostics(retriever);
    } catch (error) {
      captureSearchDiagnostics(retriever);
      throw error;
    }

    if (results.length === 0 && context.embedder) {
      await sleep(75);
      const retryRetriever = getSearchRetriever();
      try {
        results = await retryRetriever.retrieve({
          query,
          limit: category ? limit * 4 : limit,
          scopeFilter,
          source: "auto-recall",
        });
        results = filterResultsByMemoryCategory(results, category).slice(0, limit);
        captureSearchDiagnostics(retryRetriever);
      } catch (error) {
        captureSearchDiagnostics(retryRetriever);
        throw error;
      }
      return {
        results,
        diagnostics: lastSearchDiagnostics,
      };
    }

    return {
      results,
      diagnostics: lastSearchDiagnostics,
    };
  };

  const runExplain = async (
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ) => {
    if (category && !toMemoryCategory(category)) {
      throw new Error(`Invalid memory category: ${category}. Use one of: profile, preferences, entities, events, cases, patterns.`);
    }
    const retriever = getSearchRetriever();
    try {
      return await explainMemoryRetrieval(retriever, {
        query,
        limit,
        scopeFilter,
        category,
        source: "auto-recall",
        hasFtsSupport: context.store.hasFtsSupport,
      });
    } catch (error) {
      const diagnostics = typeof retriever.getLastDiagnostics === "function"
        ? retriever.getLastDiagnostics()
        : null;
      if (diagnostics) {
        return {
          text: formatRetrievalExplainText({
            query,
            count: 0,
            results: [],
            trace: {
              query,
              mode: context.retriever.getConfig().mode === "vector" ? "vector" : "hybrid",
              startedAt: Date.now(),
              stages: [],
              finalCount: 0,
              totalMs: 0,
            },
            diagnostics,
            explanation: {
              status: "empty" as const,
              summary: "Retrieval failed before a complete trace was produced.",
              reasons: [
                `Failure stage: ${diagnostics.failureStage || "unknown"}.`,
                `Error: ${error instanceof Error ? error.message : String(error)}.`,
              ],
              suggestions: ["Run mymem_debug with the same query for raw diagnostics."],
            },
          }),
          details: {
            query,
            count: 0,
            results: [],
            trace: {
              query,
              mode: context.retriever.getConfig().mode === "vector" ? "vector" as const : "hybrid" as const,
              startedAt: Date.now(),
              stages: [],
              finalCount: 0,
              totalMs: 0,
            },
            diagnostics,
            explanation: {
              status: "empty" as const,
              summary: "Retrieval failed before a complete trace was produced.",
              reasons: [
                `Failure stage: ${diagnostics.failureStage || "unknown"}.`,
                `Error: ${error instanceof Error ? error.message : String(error)}.`,
              ],
              suggestions: ["Run mymem_debug with the same query for raw diagnostics."],
            },
          },
        };
      }
      throw error;
    }
  };

  const memory = program
    .command("mymem")
    .description("Enhanced memory management commands (MyMem)");

  // Version
  memory
    .command("version")
    .description("Print plugin version")
    .action(() => {
      console.log(getPluginVersion());
    });

  registerOauthCommands(memory, context);

  // List memories
  memory
    .command("list")
    .description("List memories with optional filtering")
    .option("--scope <scope>", "Filter by scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--offset <n>", "Number of results to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit) || 20;
        const offset = parseInt(options.offset) || 0;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }
        if (options.category && !toMemoryCategory(options.category)) {
          throw new Error(`Invalid memory category: ${options.category}. Use one of: profile, preferences, entities, events, cases, patterns.`);
        }

        const memories = await context.store.list(
          scopeFilter,
          undefined,
          options.category ? Math.min(1000, limit + offset) : limit,
          options.category ? 0 : offset
        );
        const filteredMemories = filterEntriesByMemoryCategory(memories, options.category)
          .slice(options.category ? offset : 0, options.category ? offset + limit : limit);

        if (options.json) {
          console.log(formatJson(filteredMemories));
        } else {
          if (filteredMemories.length === 0) {
            console.log("No memories found.");
          } else {
            console.log(`Found ${filteredMemories.length} memories:\n`);
            filteredMemories.forEach((memory, i) => {
              console.log(formatMemory(memory, offset + i));
            });
          }
        }
      } catch (error) {
        console.error("Failed to list memories:", error);
        process.exit(1);
      }
    });

  // Search memories
  memory
    .command("search <query>")
    .description("Search memories using the same retrieval source as auto-recall")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--debug", "Show retrieval diagnostics")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const { results, diagnostics } = await runSearch(
          query,
          limit,
          scopeFilter,
          options.category,
        );

        if (options.json) {
          console.log(
            formatJson(options.debug ? { diagnostics, results } : results),
          );
        } else {
          if (options.debug && diagnostics) {
            for (const line of formatRetrievalDiagnosticsLines(diagnostics)) {
              console.log(line);
            }
            console.log();
          }
          if (results.length === 0) {
            console.log("No relevant memories found.");
          } else {
            console.log(`Found ${results.length} memories:\n`);
            results.forEach((result, i) => {
              const sources = [];
              if (result.sources.vector) sources.push("vector");
              if (result.sources.bm25) sources.push("BM25");
              if (result.sources.reranked) sources.push("reranked");

              console.log(
                `${i + 1}. [${result.entry.id}] [${getDisplayCategoryTag(result.entry)}] ${result.entry.text} ` +
                `(${(result.score * 100).toFixed(0)}%, ${sources.join('+')})`
              );
            });
          }
        }
      } catch (error) {
        const diagnostics = options.debug ? lastSearchDiagnostics : null;
        if (options.json) {
          console.log(
            formatJson(buildSearchErrorPayload(error, diagnostics, options.debug)),
          );
          process.exit(1);
        }
        if (diagnostics) {
          for (const line of formatRetrievalDiagnosticsLines(diagnostics)) {
            console.error(line);
          }
        }
        console.error("Search failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("explain <query>")
    .description("Explain why memory retrieval matched or returned no results")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "5")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 5;
        const scopeFilter = options.scope ? [options.scope] : undefined;
        const report = await runExplain(
          query,
          limit,
          scopeFilter,
          options.category,
        );
        if (options.json) {
          console.log(formatJson(report.details));
        } else {
          console.log(report.text);
        }
      } catch (error) {
        if (options.json) {
          console.log(formatJson({
            error: "explain_failed",
            message: error instanceof Error ? error.message : String(error),
          }));
          process.exit(1);
        }
        console.error("Explain failed:", error);
        process.exit(1);
      }
    });

  // Memory statistics
  memory
    .command("stats")
    .description("Show memory statistics")
    .option("--scope <scope>", "Stats for specific scope")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const scopeStats = context.scopeManager.getStats();
        const retrievalConfig = context.retriever.getConfig();

        const summary = {
          memory: stats,
          scopes: scopeStats,
          retrieval: {
            mode: retrievalConfig.mode,
            hasFtsSupport: context.store.hasFtsSupport,
          },
        };

        if (options.json) {
          console.log(formatJson(summary));
        } else {
          console.log(`Memory Statistics:`);
          console.log(`• Total memories: ${stats.totalCount}`);
          console.log(`• Available scopes: ${scopeStats.totalScopes}`);
          console.log(`• Retrieval mode: ${retrievalConfig.mode}`);
          console.log(`• FTS support: ${context.store.hasFtsSupport ? 'Yes' : 'No'}`);
          console.log();

          console.log("Memories by scope:");
          Object.entries(stats.scopeCounts).forEach(([scope, count]) => {
            console.log(`  • ${scope}: ${count}`);
          });
          console.log();

          console.log("Memories by category:");
          Object.entries(stats.categoryCounts).forEach(([category, count]) => {
            console.log(`  • ${category}: ${count}`);
          });
        }
      } catch (error) {
        console.error("Failed to get statistics:", error);
        process.exit(1);
      }
    });

  memory
    .command("dashboard")
    .description("Start a local MyMem dashboard for non-technical memory inspection")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <n>", "Port to listen on", "1314")
    .action(async (options) => {
      try {
        const port = parseInt(options.port) || 1314;
        const server = await startMemoryDashboardServer(context, {
          host: options.host || "127.0.0.1",
          port,
          authTokenFile: join(context.store.dbPath, ".dashboard-token"),
        });

        console.log(`MyMem dashboard running at ${server.url}`);
        if (server.authTokenFile) {
          console.log(`Dashboard token file: ${server.authTokenFile}`);
          console.log(`Open ${formatDashboardUnlockUrl(server.url, server.authTokenFile)} to unlock the dashboard.`);
        }
        console.log("Press Ctrl+C to stop.");

        const shutdown = async () => {
          await server.close();
          process.exit(0);
        };
        process.once("SIGINT", () => {
          void shutdown();
        });
        process.once("SIGTERM", () => {
          void shutdown();
        });
        await new Promise(() => {
          // Keep the CLI process alive while the dashboard server is running.
        });
      } catch (error) {
        console.error("Failed to start dashboard:", error);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .action(async (id, options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const deleted = await context.store.delete(id, scopeFilter);

        if (deleted) {
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          console.log(`Memory ${id} not found or access denied.`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Failed to delete memory:", error);
        process.exit(1);
      }
    });

  // Bulk delete
  memory
    .command("delete-bulk")
    .description("Bulk delete memories with filters")
    .option("--scope <scopes...>", "Scopes to delete from (required)")
    .option("--before <date>", "Delete memories before this date (YYYY-MM-DD)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options) => {
      try {
        if (!options.scope || options.scope.length === 0) {
          console.error("At least one scope must be specified for safety.");
          process.exit(1);
        }

        let beforeTimestamp: number | undefined;
        if (options.before) {
          const date = new Date(options.before);
          if (isNaN(date.getTime())) {
            console.error("Invalid date format. Use YYYY-MM-DD.");
            process.exit(1);
          }
          beforeTimestamp = date.getTime();
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be deleted");
          console.log(`Filters: scopes=${options.scope.join(',')}, before=${options.before || 'none'}`);

          // Show what would be deleted
          const stats = await context.store.stats(options.scope);
          console.log(`Would delete from ${stats.totalCount} memories in matching scopes.`);
        } else {
          const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
          console.log(`Deleted ${deletedCount} memories.`);
        }
      } catch (error) {
        console.error("Bulk delete failed:", error);
        process.exit(1);
      }
    });

  // Export memories
  memory
    .command("export")
    .description("Export memories to JSON")
    .option("--scope <scope>", "Export specific scope")
    .option("--category <category>", "Export specific category")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }
        if (options.category && !toMemoryCategory(options.category)) {
          throw new Error(`Invalid memory category: ${options.category}. Use one of: profile, preferences, entities, events, cases, patterns.`);
        }

        const memories = await context.store.list(
          scopeFilter,
          undefined,
          1000 // Large limit for export
        );
        const filteredMemories = filterEntriesByMemoryCategory(memories, options.category);

        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: filteredMemories.length,
          filters: {
            scope: options.scope,
            category: options.category,
          },
          memories: filteredMemories.map(m => ({
            ...m,
            vector: undefined, // Exclude vectors to reduce size
          })),
        };

        const output = formatJson(exportData);

        if (options.output) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(options.output, output);
          console.log(`Exported ${memories.length} memories to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (error) {
        console.error("Export failed:", error);
        process.exit(1);
      }
    });

  // Import memories
  memory
    .command("import <file>")
    .description("Import memories from JSON file")
    .option("--scope <scope>", "Import into specific scope")
    .option("--dry-run", "Show what would be imported without actually importing")
    .action(async (file, options) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(file, "utf-8");
        const data = JSON.parse(content);

        if (!data.memories || !Array.isArray(data.memories)) {
          throw new Error("Invalid import file format");
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be imported");
          console.log(`Would import ${data.memories.length} memories`);
          if (options.scope) {
            console.log(`Target scope: ${options.scope}`);
          }
          return;
        }

        console.log(`Importing ${data.memories.length} memories...`);

        let imported = 0;
        let skipped = 0;

        if (!context.embedder) {
          console.error("Import requires an embedder (not available in basic CLI mode).");
          console.error("Use the plugin's mymem_store tool or pass embedder to createMemoryCLI.");
          return;
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();

        for (const memory of data.memories) {
          try {
            const rawText = memory.text;
            if (!rawText || typeof rawText !== "string" || rawText.length < 2) {
              skipped++;
              continue;
            }

            const text = sanitizeMemoryWriteText(rawText);
            if (text.length < 2) {
              skipped++;
              continue;
            }

            const categoryRaw = typeof memory.category === "string" ? memory.category : undefined;
            const category: MemoryCategory = normalizeCategory(categoryRaw ?? "") ?? "patterns";

            const importanceRaw = Number(memory.importance);
            const importance = Number.isFinite(importanceRaw)
              ? Math.max(0, Math.min(1, importanceRaw))
              : 0.7;

            const timestampRaw = Number(memory.timestamp);
            const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

            const metadataRaw = memory.metadata;
            const metadata = buildSafeMetadata(
              typeof metadataRaw === "string"
                ? metadataRaw
                : metadataRaw != null
                  ? JSON.stringify(metadataRaw)
                  : "{}",
              { text, category, importance },
            );

            const idRaw = memory.id;
            const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;

            // Idempotency: if the import file includes an id and we already have it, skip.
            if (id && (await context.store.hasId(id))) {
              skipped++;
              continue;
            }

            // Back-compat dedupe: if no id provided, do a best-effort similarity check.
            if (!id) {
              const existing = await context.retriever.retrieve({
                query: text,
                limit: 1,
                scopeFilter: [targetScope],
              });
              if (existing.length > 0 && existing[0].score > 0.95) {
                skipped++;
                continue;
              }
            }

            const vector = await context.embedder.embedPassage(text);

            if (id) {
              await context.store.importEntry({
                id,
                text,
                vector,
                category,
                scope: targetScope,
                importance,
                timestamp,
                metadata,
              });
            } else {
              await context.store.store({
                text,
                vector,
                importance,
                category,
                scope: targetScope,
                metadata,
              });
            }

            imported++;
          } catch (error) {
            console.warn(`Failed to import memory: ${error}`);
            skipped++;
          }
        }

        console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
      } catch (error) {
        console.error("Import failed:", error);
        process.exit(1);
      }
    });

  /**
   * import-markdown: Import memories from Markdown memory files into the plugin store.
   * Targets MEMORY.md and memory/YYYY-MM-DD.md files found in OpenClaw workspaces.
   */
  memory
    .command("import-markdown [workspace-glob]")
    .description("Import memories from Markdown files (MEMORY.md, memory/YYYY-MM-DD.md) into the plugin store")
    .option("--dry-run", "Show what would be imported without importing")
    .option("--scope <scope>", "Import into specific scope (default: auto-discovered from workspace)")
    .option(
      "--openclaw-home <path>",
      "OpenClaw home directory (default: ~/.openclaw)",
    )
    .option(
      "--dedup",
      "Skip entries already in store (scope-aware exact match, requires store.bm25Search)",
    )
    .option(
      "--min-text-length <n>",
      "Minimum text length to import (default: 5)",
      "5",
    )
    .option(
      "--importance <n>",
      "Importance score for imported entries, 0.0-1.0 (default: 0.7)",
      "0.7",
    )
    .action(async (workspaceGlob, options) => {
      // [FIXED P1] Wrap with try/catch — runImportMarkdown now throws instead of process.exit(1)
      try {
        const result = await runImportMarkdown(context, workspaceGlob, options);
        if (result.foundFiles === 0) {
          console.log("No Markdown memory files found.");
        }
        // Summary is printed inside runImportMarkdown (removed duplicate output)
      } catch (err) {
        console.error(`import-markdown failed: ${err}`);
        process.exit(1);
      }
    });

  // Re-embed an existing LanceDB into the current target DB (A/B testing)
  memory
    .command("reembed")
    .description("Re-embed memories from a source LanceDB database into the current target database")
    .requiredOption("--source-db <path>", "Source LanceDB database directory")
    .option("--batch-size <n>", "Batch size for embedding calls", "32")
    .option("--limit <n>", "Limit number of rows to process (for testing)")
    .option("--dry-run", "Show what would be re-embedded without writing")
    .option("--skip-existing", "Skip entries whose id already exists in the target DB")
    .option("--force", "Allow using the same source-db as the target dbPath (DANGEROUS)")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("Re-embed requires an embedder (not available in basic CLI mode).");
          return;
        }

        const fs = await import("node:fs/promises");

        const sourceDbPath = options.sourceDb as string;
        const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
        const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1000000) : undefined;
        const dryRun = options.dryRun === true;
        const skipExisting = options.skipExisting === true;
        const force = options.force === true;

        // Safety: prevent accidental in-place re-embedding
        let sourceReal = sourceDbPath;
        let targetReal = context.store.dbPath;
        try {
          sourceReal = await fs.realpath(sourceDbPath);
        } catch { }
        try {
          targetReal = await fs.realpath(context.store.dbPath);
        } catch { }

        if (!force && sourceReal === targetReal) {
          console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
          process.exit(1);
        }

        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        const table = await db.openTable("memories");

        let query = table
          .query()
          .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]);

        if (limit) query = query.limit(limit);

        const rows = (await query.toArray())
          .filter((r: any) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .filter((r: any) => r.id && r.id !== "__schema__");

        if (rows.length === 0) {
          console.log("No source memories found.");
          return;
        }

        console.log(
          `Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`
        );

        if (dryRun) {
          console.log("DRY RUN - No memories will be written");
          console.log(`First example: ${rows[0].id?.slice?.(0, 8)} ${String(rows[0].text).slice(0, 80)}`);
          return;
        }

        let processed = 0;
        let imported = 0;
        let skipped = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const texts = batch.map((r: any) => String(r.text));
          const vectors = await context.embedder.embedBatchPassage(texts);

          for (let j = 0; j < batch.length; j++) {
            processed++;
            const row = batch[j];
            const vector = vectors[j];

            if (!vector || vector.length === 0) {
              skipped++;
              continue;
            }

            const id = String(row.id);
            if (skipExisting) {
              const exists = await context.store.hasId(id);
              if (exists) {
                skipped++;
                continue;
              }
            }

            const category = reverseMapLegacyCategory(
              typeof row.category === "string" ? row.category : undefined,
              String(row.text),
            );
            const metadata = buildSafeMetadata(
              typeof row.metadata === "string" ? row.metadata : "{}",
              {
                text: String(row.text),
                category,
                importance: (row.importance != null) ? Number(row.importance) : 0.7,
              },
            );
            const entry: MemoryEntry = {
              id,
              text: String(row.text),
              vector,
              category,
              scope: (row.scope as string | undefined) || "global",
              importance: (row.importance != null) ? Number(row.importance) : 0.7,
              timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
              metadata,
            };

            await context.store.importEntry(entry);
            imported++;
          }

          if (processed % 100 === 0 || processed === rows.length) {
            console.log(`Progress: ${processed}/${rows.length} processed, ${imported} imported, ${skipped} skipped`);
          }
        }

        console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
      } catch (error) {
        console.error("Re-embed failed:", error);
        process.exit(1);
      }
    });

  // Upgrade legacy memories to new smart memory format
  memory
    .command("upgrade")
    .description("Upgrade legacy memories to new 6-category summary/content smart memory format")
    .option("--dry-run", "Show upgrade statistics without modifying data")
    .option("--batch-size <n>", "Number of memories per batch", "10")
    .option("--no-llm", "Skip LLM calls; use simple text truncation for summary/content")
    .option("--limit <n>", "Maximum number of memories to upgrade")
    .option("--scope <scope>", "Only upgrade memories in this scope")
    .action(async (options) => {
      try {
        const upgrader = createMemoryUpgrader(
          context.store,
          options.llm === false ? null : (context.llmClient ?? null),
          { log: console.log },
        );

        // Show current status first
        const scopeFilter = options.scope ? [options.scope] : undefined;
        const counts = await upgrader.countLegacy(scopeFilter);

        console.log(`Memory Upgrade Status:`);
        console.log(`• Total memories: ${counts.total}`);
        console.log(`• Legacy (needs upgrade): ${counts.legacy}`);
        console.log(`• Already new format: ${counts.total - counts.legacy}`);
        if (Object.keys(counts.byCategory).length > 0) {
          console.log(`• Legacy by category:`);
          Object.entries(counts.byCategory).forEach(([cat, n]) => {
            console.log(`    ${cat}: ${n}`);
          });
        }

        if (counts.legacy === 0) {
          console.log(`\nAll memories are already in the new format. No upgrade needed.`);
          return;
        }

        if (options.dryRun) {
          console.log(`\n[DRY-RUN] Would upgrade ${counts.legacy} memories.`);
          return;
        }

        console.log(`\nStarting upgrade...`);
        const result = await upgrader.upgrade({
          dryRun: false,
          batchSize: parseInt(options.batchSize) || 10,
          noLlm: options.llm === false,
          limit: options.limit ? parseInt(options.limit) : undefined,
          scopeFilter,
        });

        console.log(`\nUpgrade Results:`);
        console.log(`• Upgraded: ${result.upgraded}`);
        console.log(`• Already new format: ${result.skipped}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.slice(0, 5).forEach(err => console.log(`  - ${err}`));
          if (result.errors.length > 5) {
            console.log(`  ... and ${result.errors.length - 5} more`);
          }
        }
      } catch (error) {
        console.error("Upgrade failed:", error);
        process.exit(1);
      }
    });

  // Migration commands
  const migrate = memory
    .command("migrate")
    .description("Migration utilities");

  migrate
    .command("check")
    .description("Check if migration is needed from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const check = await context.migrator.checkMigrationNeeded(options.source);

        console.log("Migration Check Results:");
        console.log(`• Legacy database found: ${check.sourceFound ? 'Yes' : 'No'}`);
        if (check.sourceDbPath) {
          console.log(`• Source path: ${check.sourceDbPath}`);
        }
        if (check.entryCount !== undefined) {
          console.log(`• Entries to migrate: ${check.entryCount}`);
        }
        console.log(`• Migration needed: ${check.needed ? 'Yes' : 'No'}`);
      } catch (error) {
        console.error("Migration check failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("run")
    .description("Run migration from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .option("--default-scope <scope>", "Default scope for migrated data", "global")
    .option("--dry-run", "Show what would be migrated without actually migrating")
    .option("--skip-existing", "Skip entries that already exist")
    .action(async (options) => {
      try {
        const result = await context.migrator.migrate({
          sourceDbPath: options.source,
          defaultScope: options.defaultScope,
          dryRun: options.dryRun,
          skipExisting: options.skipExisting,
          logger: {
            info: (message: string) => console.log(message),
            warn: (message: string) => console.warn(message),
          },
        });

        console.log("Migration Results:");
        console.log(`• Status: ${result.success ? 'Success' : 'Failed'}`);
        console.log(`• Migrated: ${result.migratedCount}`);
        console.log(`• Skipped: ${result.skippedCount}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
        console.log(`• Summary: ${result.summary}`);

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("verify")
    .description("Verify migration results")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const result = await context.migrator.verifyMigration(options.source);

        console.log("Migration Verification:");
        console.log(`• Valid: ${result.valid ? 'Yes' : 'No'}`);
        console.log(`• Source count: ${result.sourceCount}`);
        console.log(`• Target count: ${result.targetCount}`);

        if (result.issues.length > 0) {
          console.log("• Issues:");
          result.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
      }
    });

  // reindex-fts: Rebuild FTS index
  program
    .command("reindex-fts")
    .description("Rebuild the BM25 full-text search index")
    .action(async () => {
      try {
        const status = context.store.getFtsStatus();
        console.log(`FTS status before: available=${status.available}, lastError=${status.lastError || "none"}`);
        const result = await context.store.rebuildFtsIndex();
        if (result.success) {
          console.log("✅ FTS index rebuilt successfully");
        } else {
          console.error("❌ FTS rebuild failed:", result.error);
          process.exit(1);
        }
      } catch (error) {
        console.error("FTS rebuild error:", error);
        process.exit(1);
      }
    });

  // repair-summaries: Detect and fix stale summary/content metadata
  memory
    .command("repair-summaries")
    .description("Detect and fix summary/content metadata that is inconsistent with text (text updated but metadata not regenerated)")
    .option("--scope <scope>", "Filter by scope (e.g. agent:bs-intern)")
    .option("--dry-run", "Preview mode — report stale entries without modifying data", false)
    .action(async (options: { scope?: string; dryRun: boolean }) => {
      try {
        const scopeFilter = options.scope ? [options.scope] : undefined;

        // Paginate through all entries
        const allEntries: MemoryEntry[] = [];
        const pageSize = 200;
        let offset = 0;
        while (true) {
          const page = await context.store.list(scopeFilter, undefined, pageSize, offset);
          if (page.length === 0) break;
          allEntries.push(...page);
          offset += page.length;
          if (page.length < pageSize) break;
        }

        console.log(`Scanned ${allEntries.length} memories${options.scope ? ` (scope: ${options.scope})` : ""}\n`);

        const staleEntries: Array<{ entry: MemoryEntry; summaryPrefix: string; textPrefix: string }> = [];

        for (const entry of allEntries) {
          const meta = parseSmartMetadata(entry.metadata, entry);
          const textPrefix = entry.text.slice(0, 60).trim();
          const summaryPrefix = (meta.summary || "").slice(0, 60).trim();

          if (textPrefix !== summaryPrefix) {
            staleEntries.push({ entry, summaryPrefix, textPrefix });
          }
        }

        if (staleEntries.length === 0) {
          console.log("No stale summaries found. All summary/content metadata is consistent with text.");
          return;
        }

        console.log(`Found ${staleEntries.length} stale entries:\n`);

        for (const { entry, summaryPrefix, textPrefix } of staleEntries) {
          console.log(`  [${entry.id.slice(0, 8)}] scope=${entry.scope}`);
          console.log(`    text:  "${textPrefix}..."`);
          console.log(`    summary: "${summaryPrefix}..."`);
        }

        if (options.dryRun) {
          console.log(`\nDry run complete. ${staleEntries.length} entries would be repaired.`);
          return;
        }

        // Apply repairs
        let repaired = 0;
        let failed = 0;

        for (const { entry } of staleEntries) {
          try {
            // Rebuild summary/content using truncation fallback from buildSmartMetadata
            const rebuilt = buildSmartMetadata(entry, {
              summary: entry.text,
              content: entry.text,
            });
            const newMetadataStr = stringifySmartMetadata(rebuilt);
            await context.store.update(entry.id, { metadata: newMetadataStr }, scopeFilter);
            repaired++;
          } catch (err) {
            failed++;
            console.error(`  Failed to repair ${entry.id.slice(0, 8)}: ${err}`);
          }
        }

        console.log(`\nRepair complete: ${repaired} fixed, ${failed} failed out of ${staleEntries.length} stale.`);
      } catch (error) {
        console.error("repair-summaries failed:", error);
        process.exit(1);
      }
    });
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => registerMemoryCLI(program, context);
}
