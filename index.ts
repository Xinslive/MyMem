/**
 * MyMem Plugin
 * Enhanced LanceDB-backed long-term memory with hybrid retrieval and multi-scope isolation
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULT_REFLECTION_MESSAGE_COUNT, DIAG_BUILD_TAG } from "./src/plugin-constants.js";

// Detect CLI mode: when running as a CLI subcommand (e.g. `openclaw mymem stats`),
// OpenClaw sets OPENCLAW_CLI=1 in the process environment. Registration and
// lifecycle logs are noisy in CLI context (printed to stderr before command output),
// so we downgrade them to debug level when running in CLI mode.
const isCliMode = () => process.env.OPENCLAW_CLI === "1";

// Import extracted utilities
import { extractTextContent, shouldSkipReflectionMessage } from "./src/session-utils.js";
import { resolveEnvVars, resolveFirstApiKey, resolveOptionalPathWithEnv, pruneMapIfOver, resolveLlmTimeoutMs } from "./src/config-utils.js";
import { getDefaultWorkspaceDir, getDefaultMdMirrorDir, resolveWorkspaceDirFromContext } from "./src/path-utils.js";
import { AUTO_CAPTURE_MAP_MAX_ENTRIES, buildAutoCaptureConversationKeyFromIngress } from "./src/auto-capture-utils.js";
import { parsePluginConfig } from "./src/plugin-config-parser.js";
import { getPluginVersion } from "./src/version-utils.js";
import { findPreviousSessionFile, createMdMirrorWriter } from "./src/workspace-utils.js";
import { readSessionConversationWithResetFallback } from "./src/session-recovery-utils.js";

// Import core components
import { registerAllMemoryTools } from "./src/tools.js";
import { resolveScopeFilter, parseAgentIdFromSessionKey } from "./src/scopes.js";
import {
  runPreferenceDistiller,
} from "./src/preference-distiller.js";
import {
  runExperienceCompiler,
} from "./src/experience-compiler.js";
import { resolveReflectionSessionSearchDirs } from "./src/session-recovery.js";
import { createMemoryCLI } from "./cli.js";
import { normalizeAutoCaptureText } from "./src/auto-capture-cleanup.js";
import { summarizeTextPreview, summarizeMessageContent } from "./src/capture-detection.js";
import { createLlmClient } from "./src/llm-client.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";

// Import singleton state management
import {
  initPluginState,
  getSingletonState,
  setSingletonState,
  __resetSingletonForTesting__,
} from "./src/plugin-singleton.js";

// ============================================================================
// Version
// ============================================================================

const pluginVersion = getPluginVersion();
const STARTUP_HEALTH_CHECK_DELAY_MS = 15_000;

// ============================================================================
// Plugin Definition
// ============================================================================

// WeakSet keyed by API instance — each distinct API object tracks its own initialized state.
// Using WeakSet instead of a module-level boolean avoids the "second register() call skips
// hook/tool registration for the new API instance" regression that rwmjhb identified.
const _registeredApis = new WeakSet<OpenClawPluginApi>();

// ============================================================================
// Hook Event Deduplication (Phase 1)
// ============================================================================
//
// OpenClaw calls register() once per scope init (5× at startup, 4× per inbound
import { registerMemoryReflectionHook } from "./src/reflection-hook.js";
import { registerSessionMemoryHook } from "./src/session-memory-hook.js";
import { createAutoBackup } from "./src/auto-backup.js";
import { registerAutoCaptureHook } from "./src/auto-capture-hook.js";
import { registerAutoRecallHook } from "./src/auto-recall-hook.js";
import { registerSelfImprovementHook } from "./src/self-improvement-hook.js";
import { registerHookEnhancements } from "./src/hook-enhancements.js";
import { registerGatewayMaintenance } from "./src/plugin-registration.js";

const myMemPlugin = {
  id: "mymem",
  name: "MyMem",
  description:
    "Enhanced LanceDB-backed long-term memory with hybrid retrieval, multi-scope isolation, and management CLI",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Idempotent guard: skip re-init if this exact API instance has already registered.
    if (_registeredApis.has(api)) {
      api.logger.debug?.("mymem: register() called again — skipping re-init (idempotent)");
      return;
    }
    _registeredApis.add(api);

    // Parse and validate configuration
    // ========================================================================
    // Phase 2 — Singleton state: initialize heavy resources exactly once.
    // First register() call runs initPluginState(); subsequent calls reuse
    // the same singleton via destructuring. This prevents:
    //   - Memory heap growth from repeated resource creation (~9 calls/process)
    //   - Accumulated session Maps being lost on re-registration
    // ========================================================================
    if (!getSingletonState()) { setSingletonState(initPluginState(api)); }
    const {
      config,
      resolvedDbPath,
      store,
      embedder,
      retriever,
      scopeManager,
      migrator,
      smartExtractor,
      smartExtractionLlmClient,
      decayEngine,
      recencyEngine: _recencyEngine,
      hybridNoiseDetector: _hybridNoiseDetector,
      tierManager,
      extractionRateLimiter,
      feedbackLoop,
      telemetryStore,
      reflectionErrorStateBySession: _reflectionErrorStateBySession,
      reflectionDerivedBySession: _reflectionDerivedBySession,
      reflectionByAgentCache: _reflectionByAgentCache,
      recallHistory,
      turnCounter,
      lastRawUserMessage,
      hookEnhancementState,
      autoCaptureSeenTextCount,
      autoCapturePendingIngressTexts,
      autoCaptureRecentTexts,
    } = getSingletonState()!;

    const resolveGovernanceCommandContext = async (event: any): Promise<{
      sessionKey: string;
      sessionId: string;
      conversation: string | null;
      scopeFilter: string[] | undefined;
    } | null> => {
      const sessionKey = typeof event?.sessionKey === "string" ? event.sessionKey.trim() : "";
      if (!sessionKey) return null;

      const context = (event?.context || {}) as Record<string, unknown>;
      const cfg = context.cfg ?? (api as any).config ?? {};
      const workspaceDir = resolveWorkspaceDirFromContext(context);
      const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
      const scopeFilter = resolveScopeFilter(scopeManager, sourceAgentId);
      const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
      const sessionId = typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
      let currentSessionFile = typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;

      if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
        const searchDirs = resolveReflectionSessionSearchDirs({
          context,
          cfg,
          workspaceDir,
          currentSessionFile,
          sourceAgentId,
        });
        for (const sessionsDir of searchDirs) {
          const recovered = await findPreviousSessionFile(sessionsDir, currentSessionFile, sessionId);
          if (recovered) {
            currentSessionFile = recovered;
            break;
          }
        }
      }

      const conversation = currentSessionFile
        ? await readSessionConversationWithResetFallback(
            currentSessionFile,
            config.memoryReflection?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT,
          )
        : null;

      return {
        sessionKey,
        sessionId,
        conversation,
        scopeFilter,
      };
    };

    const runCommandGovernanceAutomation = async (event: any) => {
      if (config.preferenceDistiller?.enabled !== true && config.experienceCompiler?.enabled !== true) return;
      const resolved = await resolveGovernanceCommandContext(event);
      if (!resolved) return;

      if (config.preferenceDistiller?.enabled === true) {
        await runPreferenceDistiller(
          { store, embedder, logger: api.logger },
          config.preferenceDistiller,
          resolved.scopeFilter,
        );
      }

      if (config.experienceCompiler?.enabled === true) {
        await runExperienceCompiler(
          { store, embedder, logger: api.logger },
          config.experienceCompiler,
          {
            scopeFilter: resolved.scopeFilter,
            sessionKey: resolved.sessionKey,
            conversation: resolved.conversation || undefined,
          },
        );
      }
    };

    const logReg = isCliMode() ? api.logger.debug : api.logger.info;
    logReg(
      `mymem@${pluginVersion}: plugin registered (db: ${resolvedDbPath}, model: ${config.embedding.model || "text-embedding-3-small"}, smartExtraction: ${smartExtractor ? 'ON' : 'OFF'})`
    );
    logReg(`mymem: diagnostic build tag loaded (${DIAG_BUILD_TAG})`);

    // Dual-memory model warning: help users understand the two-layer architecture
    // Runs synchronously and logs warnings; does NOT block gateway startup.
    logReg(
      `[mymem] memory_recall queries the plugin store (LanceDB), not MEMORY.md.\n` +
      `  - Plugin memory (LanceDB) = primary recall source for semantic search\n` +
      `  - MEMORY.md / memory/YYYY-MM-DD.md = startup context / journal only\n` +
      `  - Use memory_store or auto-capture for recallable memories.\n`
    );

    // Health status for memory runtime stub (reflects actual plugin health)
    // Updated by runStartupChecks after testing embedder and retriever
    let embedHealth: { ok: boolean; error?: string } = { ok: false, error: "startup not complete" };
    let retrievalHealth: boolean = false;

    // ========================================================================
    // Stub Memory Runtime (satisfies openclaw doctor memory plugin check)
    // mymem uses a tool-based architecture, not the built-in memory-core
    // runtime interface, so we register a minimal stub to satisfy the check.
    // See: https://github.com/Xinslive/MyMem/issues/434
    // ========================================================================
    if (typeof api.registerMemoryRuntime === "function") {
      api.registerMemoryRuntime({
        async getMemorySearchManager(_params: any) {
          return {
            manager: {
              status: () => ({
                backend: "builtin" as const,
                provider: "mymem",
                embeddingAvailable: embedHealth.ok,
                retrievalAvailable: retrievalHealth,
              }),
              probeEmbeddingAvailability: async () => ({ ...embedHealth }),
              probeVectorAvailability: async () => retrievalHealth,
            },
          };
        },
        resolveMemoryBackendConfig() {
          return { backend: "builtin" as const };
        },
      });
    }

    api.on("message_received", (event: any, ctx: any) => {
      const conversationKey = buildAutoCaptureConversationKeyFromIngress(
        ctx.channelId,
        ctx.conversationId,
      );
      const rawIngressText = extractTextContent(event.content);
      const normalized = rawIngressText
        ? normalizeAutoCaptureText("user", rawIngressText, shouldSkipReflectionMessage)
        : null;
      if (conversationKey && normalized) {
        const queue = autoCapturePendingIngressTexts.get(conversationKey) || [];
        queue.push(normalized);
        autoCapturePendingIngressTexts.set(conversationKey, queue.slice(-6));
        pruneMapIfOver(autoCapturePendingIngressTexts, AUTO_CAPTURE_MAP_MAX_ENTRIES);
      }
      const ingressLength = typeof rawIngressText === "string" ? rawIngressText.trim().length : 0;
      api.logger.debug(
        `mymem: ingress message_received channel=${ctx.channelId} account=${ctx.accountId || "unknown"} conversation=${ctx.conversationId || "unknown"} from=${event.from} len=${ingressLength} preview=${summarizeTextPreview(rawIngressText || "")}`,
      );
    });

    api.on("before_message_write", (event: any, ctx: any) => {
      const message = event.message as Record<string, unknown> | undefined;
      const role =
        message && typeof message.role === "string" && message.role.trim().length > 0
          ? message.role
          : "unknown";
      if (role !== "user") {
        return;
      }
      api.logger.debug(
        `mymem: ingress before_message_write agent=${ctx.agentId || event.agentId || "unknown"} sessionKey=${ctx.sessionKey || event.sessionKey || "unknown"} role=${role} ${summarizeMessageContent(message?.content)}`,
      );
    });

    // ========================================================================
    // Markdown Mirror
    // ========================================================================

    const mdMirror = createMdMirrorWriter(api, config);

    // ========================================================================
    // Register Tools
    // ========================================================================

    registerAllMemoryTools(
      api,
      {
        retriever,
        store,
        scopeManager,
        embedder,
        logger: api.logger,
        agentId: undefined, // Will be determined at runtime from context
        workspaceDir: getDefaultWorkspaceDir(),
        mdMirror,
        workspaceBoundary: config.workspaceBoundary,
        telemetry: telemetryStore,
      },
      {
        enableManagementTools: config.enableManagementTools,
        enableSelfImprovementTools: config.selfImprovement?.enabled !== false,
      }
    );

    registerGatewayMaintenance({
      api,
      config,
      store,
      embedder,
      decayEngine,
      tierManager,
      smartExtractionLlmClient,
      resolvedDbPath,
    });

    // ========================================================================
    // Register CLI Commands
    // ========================================================================

    api.registerCli?.(
      createMemoryCLI({
        store,
        retriever,
        scopeManager,
        migrator,
        embedder,
        llmClient: smartExtractor ? (() => {
          try {
            const llmAuth = config.llm?.auth || "api-key";
            const llmApiKey = llmAuth === "oauth"
              ? undefined
              : config.llm?.apiKey
                ? resolveEnvVars(config.llm.apiKey)
                : resolveFirstApiKey(config.embedding.apiKey);
            const llmBaseURL = llmAuth === "oauth"
              ? (config.llm?.baseURL ? resolveEnvVars(config.llm.baseURL) : undefined)
              : config.llm?.baseURL
                ? resolveEnvVars(config.llm.baseURL)
                : config.embedding.baseURL;
            const llmOauthPath = llmAuth === "oauth"
              ? resolveOptionalPathWithEnv(api, config.llm?.oauthPath, ".mymem/oauth.json")
              : undefined;
            const llmOauthProvider = llmAuth === "oauth"
              ? config.llm?.oauthProvider
              : undefined;
            const llmTimeoutMs = resolveLlmTimeoutMs(config);
            return createLlmClient({
              auth: llmAuth,
              apiKey: llmApiKey,
              model: config.llm?.model || "openai/gpt-oss-120b",
              baseURL: llmBaseURL,
              oauthProvider: llmOauthProvider,
              oauthPath: llmOauthPath,
              timeoutMs: llmTimeoutMs,
              log: (msg: string) => api.logger.debug(msg),
            });
          } catch { return undefined; }
        })() : undefined,
      }),
      { commands: ["mymem"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts.
    // Subagent sessions are guarded inside registerAutoRecallHook via :subagent:.
    registerAutoRecallHook({
      api,
      config,
      store,
      retriever,
      scopeManager,
      turnCounter,
      recallHistory,
      lastRawUserMessage,
      hookEnhancementState,
      decayEngine,
      tierManager,
    });

    registerHookEnhancements({
      api,
      config,
      store,
      embedder,
      scopeManager,
      state: hookEnhancementState,
      isCliMode,
    });

    // Auto-capture hook
    registerAutoCaptureHook({
      api,
      config,
      store,
      embedder,
      smartExtractor,
      extractionRateLimiter,
      scopeManager,
      autoCaptureSeenTextCount,
      autoCapturePendingIngressTexts,
      autoCaptureRecentTexts,
      mdMirror: mdMirror ?? undefined,
      isCliMode,
    });

    // ========================================================================
    // Integrated Self-Improvement (inheritance + derived)
    // ========================================================================

    registerSelfImprovementHook({ api, config, isCliMode });

    // ========================================================================
    // Integrated Memory Reflection (reflection)
    // ========================================================================

    registerMemoryReflectionHook({
      api,
      config,
      store,
      embedder,
      scopeManager,
      mdMirror,
      smartExtractionLlmClient,
      resolvedDbPath,
      singletonState: getSingletonState()!,
      isCliMode,
    });

    if (config.preferenceDistiller?.enabled === true || config.experienceCompiler?.enabled === true) {
      const runGovernanceAutomationOnCommand = async (event: any) => {
        try {
          await runCommandGovernanceAutomation(event);
        } catch (err) {
          api.logger.warn(`memory-governance: command hook failed: ${String(err)}`);
        }
      };

      api.registerHook?.("command:new", runGovernanceAutomationOnCommand, {
        name: "mymem.memory-governance.command-new",
        description: "Run preference distillation and experience compilation before /new",
      });
      api.registerHook?.("command:reset", runGovernanceAutomationOnCommand, {
        name: "mymem.memory-governance.command-reset",
        description: "Run preference distillation and experience compilation before /reset",
      });
      (isCliMode() ? api.logger.debug : api.logger.info)(
        "memory-governance: integrated hooks registered (command:new, command:reset)"
      );
    }

    registerSessionMemoryHook({ api, config, store, embedder, scopeManager, isCliMode });
    if (config.sessionStrategy === "none") {
      (isCliMode() ? api.logger.debug : api.logger.info)("session-strategy: using none (plugin memory-reflection hooks disabled)");
    }

    // ========================================================================
    // Auto-Backup (daily JSONL export)
    // ========================================================================

    const autoBackup = createAutoBackup({ api, store, resolvedDbPath });

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService?.({
      id: "mymem",
      start: async () => {
        // IMPORTANT: Do not block gateway startup on external network calls.
        // If embedding/retrieval tests hang (bad network / slow provider), the gateway
        // may never bind its HTTP port, causing restart timeouts.

        const withTimeout = <T>(
          factory: (signal: AbortSignal) => Promise<T>,
          ms: number,
          label: string,
        ): { promise: Promise<T>; signal: AbortSignal } => {
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => {
                controller.abort();
                reject(new Error(`${label} timed out after ${ms}ms`));
              },
              ms,
            );
          });
          const p = factory(controller.signal).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          return { promise: Promise.race([p, timeoutPromise]), signal: controller.signal };
        };

        // Embedder internal timeout is 20s; give startup checks enough headroom
        const startupTimeoutMs = 30_000;

        const runStartupChecks = async () => {
          try {
            // Test components (bounded time)
            let embedSuccess = false;
            let embedError: string | undefined;
            try {
              const embedTest = await withTimeout(
                (signal) => embedder.test(signal),
                startupTimeoutMs,
                "embedder.test()",
              ).promise;
              embedSuccess = !!embedTest.success;
              embedError = embedTest.error;
            } catch (timeoutErr) {
              // Embedding provider may be slow on cold start — not a permanent failure.
              // The plugin works fine once the provider warms up (confirmed by memory_doctor).
              embedError = String(timeoutErr);
              api.logger.debug?.(
                `mymem: embedding probe skipped (provider not ready): ${embedError}`,
              );
            }

            const retrievalTest: {
              success: boolean;
              mode: string;
              hasFtsSupport: boolean;
              ftsError?: string;
              error?: string;
            } = {
              success: true,
              mode: retriever.getConfig().mode,
              hasFtsSupport: store.hasFtsSupport,
              ftsError: store.lastFtsError ?? undefined,
            };
            const ftsStatus = retrievalTest.hasFtsSupport
              ? "enabled"
              : `disabled${retrievalTest.ftsError ? ` (${retrievalTest.ftsError})` : ""}`;

            if (embedSuccess) {
              api.logger.info(
                `mymem: initialized successfully ` +
                `(embedding: OK, ` +
                `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
                `mode: ${retrievalTest.mode}, ` +
                `FTS: ${ftsStatus})`,
              );
            } else {
              // Embedding not ready at startup — log as info, not error.
              // It will work on first actual use once the provider warms up.
              api.logger.info(
                `mymem: initialized ` +
                `(embedding: warming up, ` +
                `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
                `mode: ${retrievalTest.mode}, ` +
                `FTS: ${ftsStatus})`,
              );
            }

            if (!retrievalTest.success) {
              api.logger.warn(
                `mymem: retrieval test failed: ${retrievalTest.error}`,
              );
            }

            // Update stub health status so openclaw doctor reflects real state
            embedHealth = { ok: embedSuccess, error: embedError };
            retrievalHealth = !!retrievalTest.success;
          } catch (error) {
            api.logger.warn(
              `mymem: startup checks failed: ${String(error)}`,
            );
          }
        };

        // Fire-and-forget: allow gateway to start serving immediately, then
        // defer health probing so startup I/O does not contend with host init.
        setTimeout(() => void runStartupChecks(), STARTUP_HEALTH_CHECK_DELAY_MS);

        // Check for legacy memories that could be upgraded
        setTimeout(async () => {
          try {
            const upgrader = createMemoryUpgrader(store, null);
            const counts = await upgrader.countLegacy();
            if (counts.legacy > 0) {
              api.logger.info(
                `mymem: found ${counts.legacy} legacy memories (of ${counts.total} total) that can be upgraded to the new smart memory format. ` +
                `Run 'openclaw mymem upgrade' to convert them.`
              );
            }
          } catch {
            // Non-critical: silently ignore
          }
        }, 5_000);

        // Run initial backup after a short delay, then schedule daily
        autoBackup.start();

        // Start feedback loop timers if enabled
        if (feedbackLoop) feedbackLoop.start();
      },
      stop: async () => {
        autoBackup.stop();
        if (feedbackLoop) feedbackLoop.dispose();
        api.logger.info("mymem: stopped");
      },
    });
  },
};

export { getDefaultMdMirrorDir, parsePluginConfig };

/**
 * Resets the registration state — primarily intended for use in tests that need
 * to unload/reload the plugin without restarting the process.
 * @public
 */
export function resetRegistration() {
  // Note: WeakSets cannot be cleared by design. In test scenarios where the
  // same process reloads the module, a fresh module state means a new WeakSet.
  // For hot-reload scenarios, the module is re-imported fresh.
  // (WeakSet.clear() does not exist, so we do nothing here.)
}

export { __resetSingletonForTesting__ };

export default myMemPlugin;
