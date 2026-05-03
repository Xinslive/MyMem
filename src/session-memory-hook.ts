/**
 * Session Memory Hook Registration
 *
 * Extracted from index.ts. Stores session summaries as memories on /new reset.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./plugin-types.js";
import type { MemoryStore } from "./store.js";
import type { ScopeManager } from "./scopes.js";
import { summarizeRecentConversationMessages } from "./session-utils.js";
import { readSessionConversationWithResetFallback } from "./session-recovery-utils.js";

export interface SessionMemoryHookParams {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: unknown;
  scopeManager: ScopeManager;
  isCliMode: () => boolean;
}

export function registerSessionMemoryHook(params: SessionMemoryHookParams): void {
  const { api, config, isCliMode } = params;

  if (config.sessionStrategy !== "systemSessionMemory") return;

  const sessionMessageCount = config.sessionMemory?.messageCount ?? 15;

  api.on("before_reset", async (event, ctx) => {
    if (event.reason !== "new") return;

    try {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      const currentSessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim().length > 0 ? ctx.sessionId : "unknown";
      const sessionContent =
        summarizeRecentConversationMessages(event.messages ?? [], sessionMessageCount) ??
        (typeof event.sessionFile === "string" ? await readSessionConversationWithResetFallback(event.sessionFile, sessionMessageCount) : null);

      if (!sessionContent) { api.logger.debug("session-memory: no session content found, skipping"); return; }

      api.logger.info(`session-memory: skipped main memory write for ${currentSessionId} (runtime creation is limited to manual and autoCapture paths; sessionKey=${sessionKey || "unknown"})`);
    } catch (err) {
      api.logger.warn(`session-memory: failed to process before_reset summary: ${String(err)}`);
    }
  });

  (isCliMode() ? api.logger.debug : api.logger.info)("session-memory: before_reset hook registered in update-only mode (no main-store session summaries)");
}
