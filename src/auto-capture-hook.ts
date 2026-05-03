/**
 * Auto-Capture Hook Registration
 *
 * Registers hooks for automatic memory capture after agent ends.
 */

import { resolveHookAgentId } from "./config-utils.js";
import { resolveScopeFilter, isSystemBypassId } from "./scopes.js";
import { normalizeAutoCaptureText } from "./auto-capture-cleanup.js";
import {
  buildAutoCaptureConversationKeyFromIngress,
  buildAutoCaptureConversationKeyFromSessionKey,
} from "./auto-capture-utils.js";
import { shouldSkipReflectionMessage, summarizeAgentEndMessages } from "./session-utils.js";
import type { PluginConfig } from "./plugin-types.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ScopeManager } from "./scopes.js";
import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { SmartExtractor } from "./smart-extractor.js";
import type { ExtractionRateLimiter } from "./smart-extractor.js";
import { preflightAutoCaptureText } from "./hook-enhancements.js";

type CaptureItem = { role: "user" | "assistant"; text: string };

function shouldCaptureAssistantForAgent(config: PluginConfig, agentId: string): boolean {
  if (config.captureAssistant === true) return true;
  if (config.captureAssistant === false && config.captureAssistantAgents === undefined) return false;

  const captureAssistantAgents = config.captureAssistantAgents ?? ["main"];
  return captureAssistantAgents.includes(agentId);
}

function textsOf(items: CaptureItem[]): string[] {
  return items.map((item) => item.text);
}

function formatConversationForSmartExtraction(items: CaptureItem[]): string {
  return items
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}:\n${item.text}`)
    .join("\n\n");
}

export function registerAutoCaptureHook(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: Embedder;
  smartExtractor: SmartExtractor | null;
  extractionRateLimiter: ExtractionRateLimiter;
  scopeManager: ScopeManager;
  autoCaptureSeenTextCount: Map<string, number>;
  autoCapturePendingIngressTexts: Map<string, string[]>;
  autoCaptureRecentTexts: Map<string, string[]>;
  mdMirror?: (entry: any, opts: any) => Promise<void>;
  isCliMode: () => boolean;
}): void {
  const { api, config, smartExtractor, extractionRateLimiter, scopeManager } = params;

  if (config.autoCapture === false) return;

  type AgentEndAutoCaptureHook = {
    (event: any, ctx: any): void;
    __lastRun?: Promise<void>;
  };

  const agentEndAutoCaptureHook: AgentEndAutoCaptureHook = (event, ctx) => {
    if (!event.success || !event.messages || event.messages.length === 0) {
      return;
    }

    const backgroundRun = (async () => {
      try {
        if (extractionRateLimiter.isRateLimited()) {
          api.logger.debug(
            `mymem: auto-capture skipped (rate limited: ${extractionRateLimiter.getRecentCount()} extractions in last hour)`,
          );
          return;
        }

        const agentId = resolveHookAgentId(ctx?.agentId, (event as any).sessionKey);
        const accessibleScopes = resolveScopeFilter(scopeManager, agentId);
        const defaultScope = isSystemBypassId(agentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(agentId);
        const sessionKey = ctx?.sessionKey || (event as any).sessionKey || "unknown";
        const captureAssistantForAgent = shouldCaptureAssistantForAgent(config, agentId);

        api.logger.debug(
          `mymem: auto-capture agent_end payload for agent ${agentId} (sessionKey=${sessionKey}, captureAssistant=${captureAssistantForAgent}, ${summarizeAgentEndMessages(event.messages)})`,
        );

        const eligibleItems: Array<{ role: "user" | "assistant"; text: string }> = [];
        let skippedAutoCaptureTexts = 0;
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;
          const rawRole = msgObj.role;
          if (rawRole !== "user" && rawRole !== "assistant") continue;
          const role = rawRole;
          if (role !== "user" && !(captureAssistantForAgent && role === "assistant")) continue;

          const content = msgObj.content;
          if (typeof content === "string") {
            const normalized = normalizeAutoCaptureText(role, content, shouldSkipReflectionMessage);
            if (!normalized) skippedAutoCaptureTexts++;
            else eligibleItems.push({ role, text: normalized });
            continue;
          }

          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                (block as Record<string, unknown>).type === "text" &&
                "text" in block &&
                typeof (block as Record<string, unknown>).text === "string"
              ) {
                const text = (block as Record<string, unknown>).text as string;
                const normalized = normalizeAutoCaptureText(role, text, shouldSkipReflectionMessage);
                if (!normalized) skippedAutoCaptureTexts++;
                else eligibleItems.push({ role, text: normalized });
              }
            }
          }
        }

        const conversationKey = buildAutoCaptureConversationKeyFromSessionKey(sessionKey);
        const pendingIngressTexts = conversationKey
          ? [...(params.autoCapturePendingIngressTexts.get(conversationKey) || [])]
          : [];
        if (conversationKey) {
          params.autoCapturePendingIngressTexts.delete(conversationKey);
        }

        const previousSeenCount = params.autoCaptureSeenTextCount.get(sessionKey) ?? 0;
        const eligibleTexts = eligibleItems.map((item) => item.text);
        const unseenEligibleItems = previousSeenCount > 0 && eligibleItems.length > previousSeenCount
          ? eligibleItems.slice(previousSeenCount)
          : eligibleItems;
        let newItems = unseenEligibleItems;
        if (pendingIngressTexts.length > 0) {
          newItems = [
            ...pendingIngressTexts.map((text) => ({ role: "user" as const, text })),
            ...unseenEligibleItems.filter((item) => item.role === "assistant"),
          ];
        }
        params.autoCaptureSeenTextCount.set(sessionKey, eligibleTexts.length);

        let captureItems: CaptureItem[] = [];
        for (const item of newItems) {
          if (await preflightAutoCaptureText({ config, text: item.text, api, source: `agent_end:${item.role}` })) {
            captureItems.push(item);
          }
        }
        const priorRecentTexts = params.autoCaptureRecentTexts.get(sessionKey) || [];
        if (newItems.length > 0) {
          const nextRecentTexts = [...priorRecentTexts, ...newItems.map((item) => item.text)].slice(-6);
          params.autoCaptureRecentTexts.set(sessionKey, nextRecentTexts);
        }

        const captureMaxMessages = Math.max(1, Math.min(50, Math.floor(config.captureMaxMessages ?? 10)));
        captureItems = captureItems.slice(-captureMaxMessages);
        const texts = textsOf(captureItems);
        if (skippedAutoCaptureTexts > 0) {
          api.logger.debug(`mymem: auto-capture skipped ${skippedAutoCaptureTexts} injected/system text block(s) for agent ${agentId}`);
        }
        if (pendingIngressTexts.length > 0) {
          api.logger.debug(`mymem: auto-capture using ${pendingIngressTexts.length} pending ingress text(s) for agent ${agentId}`);
        }
        if (texts.length !== eligibleTexts.length) {
          api.logger.debug(`mymem: auto-capture narrowed ${eligibleTexts.length} eligible history text(s) to ${texts.length} new text(s) for agent ${agentId}`);
        }
        api.logger.debug(`mymem: auto-capture collected ${texts.length} text(s) for agent ${agentId} (captureMaxMessages=${captureMaxMessages}, smartExtraction=${smartExtractor ? "on" : "off"})`);
        if (texts.length === 0) {
          api.logger.debug(`mymem: auto-capture found no eligible texts after filtering for agent ${agentId}`);
          return;
        }

        if (!smartExtractor) {
          api.logger.debug(`mymem: auto-capture skipped for agent ${agentId} (smart extraction unavailable; regex fallback disabled)`);
          return;
        }

        api.logger.debug(`mymem: auto-capture running smart extraction for agent ${agentId} (${captureItems.length} message(s))`);
        const stats = await smartExtractor.extractAndPersist(
          formatConversationForSmartExtraction(captureItems),
          sessionKey,
          { scope: defaultScope, scopeFilter: accessibleScopes },
        );
        extractionRateLimiter.recordExtraction();
        if (stats.created > 0 || stats.merged > 0) {
          api.logger.info(`mymem: smart-extracted ${stats.created} created, ${stats.merged} merged, ${stats.skipped} skipped for agent ${agentId}`);
        }
      } catch (err) {
        api.logger.warn(`mymem: capture failed: ${String(err)}`);
      }
    })();
    agentEndAutoCaptureHook.__lastRun = backgroundRun;
    void backgroundRun;
  };

  api.on("agent_end", agentEndAutoCaptureHook);
  api.on("session_end", (_event: any, ctx: any) => {
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (sessionKey) {
      params.autoCaptureSeenTextCount.delete(sessionKey);
      params.autoCaptureRecentTexts.delete(sessionKey);
    }

    const ingressConversationKey = buildAutoCaptureConversationKeyFromIngress(
      ctx?.channelId,
      ctx?.conversationId,
    );
    if (ingressConversationKey) {
      params.autoCapturePendingIngressTexts.delete(ingressConversationKey);
    }

    const sessionConversationKey = sessionKey
      ? buildAutoCaptureConversationKeyFromSessionKey(sessionKey)
      : null;
    if (sessionConversationKey) {
      params.autoCapturePendingIngressTexts.delete(sessionConversationKey);
    }
  });
}
