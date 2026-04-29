/**
 * Session Memory Hook Registration
 *
 * Extracted from index.ts. Stores session summaries as memories on /new reset.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./plugin-types.js";
import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { ScopeManager } from "./scopes.js";
import { resolveHookAgentId, resolveSourceFromSessionKey } from "./config-utils.js";
import { isSystemBypassId } from "./scopes.js";
import { summarizeRecentConversationMessages } from "./session-utils.js";
import { readSessionConversationWithResetFallback } from "./session-recovery-utils.js";
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";

export interface SessionMemoryHookParams {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: Embedder;
  scopeManager: ScopeManager;
  isCliMode: () => boolean;
}

export function registerSessionMemoryHook(params: SessionMemoryHookParams): void {
  const { api, config, store, embedder, scopeManager, isCliMode } = params;

  if (config.sessionStrategy !== "systemSessionMemory") return;

  const sessionMessageCount = config.sessionMemory?.messageCount ?? 15;

  const storeSystemSessionSummary = async (summaryParams: {
    agentId: string;
    defaultScope: string;
    sessionKey: string;
    sessionId: string;
    source: string;
    sessionContent: string;
    timestampMs?: number;
  }) => {
    const now = new Date(summaryParams.timestampMs ?? Date.now());
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().split("T")[1].split(".")[0];
    const memoryText = [
      `Session: ${dateStr} ${timeStr} UTC`,
      `Session Key: ${summaryParams.sessionKey}`,
      `Session ID: ${summaryParams.sessionId}`,
      `Source: ${summaryParams.source}`,
      "",
      "Conversation Summary:",
      summaryParams.sessionContent,
    ].join("\n");

    const vector = await embedder.embedPassage(memoryText);
    await store.store({
      text: memoryText,
      vector,
      category: "fact",
      scope: summaryParams.defaultScope,
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: `Session summary for ${dateStr}`, category: "fact", importance: 0.5, timestamp: Date.now() },
          {
            l0_abstract: `Session summary for ${dateStr}`,
            l1_overview: `- Session summary saved for ${summaryParams.sessionId}`,
            l2_content: memoryText,
            memory_category: "patterns",
            tier: "peripheral",
            confidence: 0.5,
            type: "session-summary",
            sessionKey: summaryParams.sessionKey,
            sessionId: summaryParams.sessionId,
            date: dateStr,
            agentId: summaryParams.agentId,
            scope: summaryParams.defaultScope,
          },
        ),
      ),
    });

    api.logger.info(`session-memory: stored session summary for ${summaryParams.sessionId} (agent: ${summaryParams.agentId}, scope: ${summaryParams.defaultScope})`);
  };

  api.on("before_reset", async (event, ctx) => {
    if (event.reason !== "new") return;

    try {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      const agentId = resolveHookAgentId(typeof ctx.agentId === "string" ? ctx.agentId : undefined, sessionKey);
      const defaultScope = isSystemBypassId(agentId) ? config.scopes?.default ?? "global" : scopeManager.getDefaultScope(agentId);
      const currentSessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim().length > 0 ? ctx.sessionId : "unknown";
      const source = resolveSourceFromSessionKey(sessionKey);
      const sessionContent =
        summarizeRecentConversationMessages(event.messages ?? [], sessionMessageCount) ??
        (typeof event.sessionFile === "string" ? await readSessionConversationWithResetFallback(event.sessionFile, sessionMessageCount) : null);

      if (!sessionContent) { api.logger.debug("session-memory: no session content found, skipping"); return; }

      await storeSystemSessionSummary({ agentId, defaultScope, sessionKey, sessionId: currentSessionId, source, sessionContent });
    } catch (err) {
      api.logger.warn(`session-memory: failed to save: ${String(err)}`);
    }
  });

  (isCliMode() ? api.logger.debug : api.logger.info)("session-memory: typed before_reset hook registered for /new session summaries");
}
