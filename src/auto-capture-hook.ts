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
import { shouldCapture, detectCategory } from "./capture-detector.js";
import { summarizeCaptureDecision } from "./capture-detection.js";
import { isNoise } from "./noise-filter.js";
import { isUserMdExclusiveMemory } from "./workspace-boundary.js";
import { isExplicitRememberCommand, shouldSkipReflectionMessage, summarizeAgentEndMessages } from "./session-utils.js";
import { buildSmartMetadata, stringifySmartMetadata, reverseMapLegacyCategory } from "./smart-metadata.js";
import type { PluginConfig } from "./plugin-types.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ScopeManager } from "./scopes.js";
import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { SmartExtractor } from "./smart-extractor.js";
import type { ExtractionRateLimiter } from "./smart-extractor.js";
import { preflightAutoCaptureText } from "./hook-enhancements.js";

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
  const { api, config, store, embedder, smartExtractor, extractionRateLimiter, scopeManager } = params;

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

        api.logger.debug(
          `mymem: auto-capture agent_end payload for agent ${agentId} (sessionKey=${sessionKey}, captureAssistant=${config.captureAssistant === true}, ${summarizeAgentEndMessages(event.messages)})`,
        );

        const eligibleItems: Array<{ role: "user" | "assistant"; text: string }> = [];
        let skippedAutoCaptureTexts = 0;
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;
          const rawRole = msgObj.role;
          if (rawRole !== "user" && rawRole !== "assistant") continue;
          const role = rawRole;
          const captureAssistant = config.captureAssistant === true;
          if (role !== "user" && !(captureAssistant && role === "assistant")) continue;

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

        let texts: string[] = [];
        for (const item of newItems) {
          if (await preflightAutoCaptureText({ config, text: item.text, api, source: `agent_end:${item.role}` })) {
            texts.push(item.text);
          }
        }
        const priorRecentTexts = params.autoCaptureRecentTexts.get(sessionKey) || [];
        if (texts.length === 1 && isExplicitRememberCommand(texts[0]) && priorRecentTexts.length > 0) {
          texts = [...priorRecentTexts.slice(-1), ...texts];
        }
        if (newItems.length > 0) {
          const nextRecentTexts = [...priorRecentTexts, ...newItems.map((item) => item.text)].slice(-6);
          params.autoCaptureRecentTexts.set(sessionKey, nextRecentTexts);
        }

        const minMessages = config.extractMinMessages ?? 5;
        if (skippedAutoCaptureTexts > 0) {
          api.logger.debug(`mymem: auto-capture skipped ${skippedAutoCaptureTexts} injected/system text block(s) for agent ${agentId}`);
        }
        if (pendingIngressTexts.length > 0) {
          api.logger.debug(`mymem: auto-capture using ${pendingIngressTexts.length} pending ingress text(s) for agent ${agentId}`);
        }
        if (texts.length !== eligibleTexts.length) {
          api.logger.debug(`mymem: auto-capture narrowed ${eligibleTexts.length} eligible history text(s) to ${texts.length} new text(s) for agent ${agentId}`);
        }
        api.logger.debug(`mymem: auto-capture collected ${texts.length} text(s) for agent ${agentId} (minMessages=${minMessages}, smartExtraction=${smartExtractor ? "on" : "off"})`);
        if (texts.length > 0) {
          api.logger.debug(`mymem: auto-capture text diagnostics for agent ${agentId}: ${texts.map((text, idx) => `#${idx + 1}(${summarizeCaptureDecision(text)})`).join(" | ")}`);
        }
        if (texts.length === 0) {
          api.logger.debug(`mymem: auto-capture found no eligible texts after filtering for agent ${agentId}`);
          return;
        }

        let fallbackTexts = texts;
        if (smartExtractor) {
          const cleanTexts = await smartExtractor.filterNoiseByEmbedding(texts);
          if (cleanTexts.length === 0) {
            api.logger.debug(`mymem: all texts filtered as embedding noise for agent ${agentId}`);
            return;
          }
          fallbackTexts = cleanTexts;
          if (cleanTexts.length >= minMessages) {
            api.logger.debug(`mymem: auto-capture running smart extraction for agent ${agentId} (${cleanTexts.length} clean texts >= ${minMessages})`);
            const conversationText = cleanTexts.join("\n");
            const stats = await smartExtractor.extractAndPersist(
              conversationText, sessionKey,
              { scope: defaultScope, scopeFilter: accessibleScopes },
            );
            extractionRateLimiter.recordExtraction();
            if (stats.created > 0 || stats.merged > 0) {
              api.logger.info(`mymem: smart-extracted ${stats.created} created, ${stats.merged} merged, ${stats.skipped} skipped for agent ${agentId}`);
              return;
            }

            if ((stats.boundarySkipped ?? 0) > 0) {
              api.logger.debug(`mymem: smart extraction skipped ${stats.boundarySkipped} USER.md-exclusive candidate(s) for agent ${agentId}; continuing to regex fallback for non-boundary texts`);
            }
          }
        }

        api.logger.debug(`mymem: auto-capture running regex fallback for agent ${agentId}`);

        const toCapture = fallbackTexts.filter((text) => text && shouldCapture(text) && !isNoise(text));
        if (toCapture.length === 0) {
          api.logger.debug(`mymem: regex fallback found 0 capturable texts for agent ${agentId}`);
          return;
        }

        api.logger.debug(`mymem: regex fallback found ${toCapture.length} capturable text(s) for agent ${agentId}`);

        let stored = 0;
        for (const text of toCapture.slice(0, 2)) {
          if (isUserMdExclusiveMemory({ text }, config.workspaceBoundary)) {
            api.logger.debug(`mymem: skipped USER.md-exclusive auto-capture text for agent ${agentId}`);
            continue;
          }

          const category = detectCategory(text);
          const vector = await embedder.embedPassage(text);

          let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
          try {
            existing = await store.vectorSearch(vector, 1, 0.1, [defaultScope]);
          } catch (err) {
            api.logger.warn(`mymem: auto-capture duplicate pre-check failed: ${String(err)}`);
          }

          if (existing.length > 0 && existing[0].score > 0.90) continue;

          await store.store({
            text,
            vector,
            importance: 0.7,
            category,
            scope: defaultScope,
            metadata: stringifySmartMetadata(
              buildSmartMetadata(
                { text, category, importance: 0.7 },
                {
                  l0_abstract: text,
                  l1_overview: `- ${text}`,
                  l2_content: text,
                  memory_category: reverseMapLegacyCategory(category, text),
                  source_session: (event as any).sessionKey || "unknown",
                  source: "auto-capture",
                  state: "confirmed",
                  memory_layer: "working",
                  injected_count: 0,
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                },
              ),
            ),
          });
          stored++;

          if (params.mdMirror) {
            await params.mdMirror(
              { text, category, scope: defaultScope, timestamp: Date.now() },
              { source: "auto-capture", agentId },
            );
          }
        }

        if (stored > 0) {
          api.logger.info(`mymem: auto-captured ${stored} memories for agent ${agentId} in scope ${defaultScope}`);
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
