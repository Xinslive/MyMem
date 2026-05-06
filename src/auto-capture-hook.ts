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

function textsOf(items: CaptureItem[]): string[] {
  return items.map((item) => item.text);
}

function formatConversationForSmartExtraction(items: CaptureItem[]): string {
  return items
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}:\n${item.text}`)
    .join("\n\n");
}

function resolveCaptureAgents(config: PluginConfig): string[] {
  const legacyCaptureAgents = (config as { captureAssistantAgents?: string[] }).captureAssistantAgents;
  return config.captureAgents ?? legacyCaptureAgents ?? ["main"];
}

function clearPendingIngressForSession(
  pendingIngressTexts: Map<string, string[]>,
  sessionKey: string,
): void {
  const conversationKey = buildAutoCaptureConversationKeyFromSessionKey(sessionKey);
  if (conversationKey) pendingIngressTexts.delete(conversationKey);
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
        const sessionKey = ctx?.sessionKey || (event as any).sessionKey || "unknown";
        const agentId = resolveHookAgentId(ctx?.agentId, sessionKey);
        const captureAgents = resolveCaptureAgents(config);
        if (!captureAgents.includes(agentId)) {
          clearPendingIngressForSession(params.autoCapturePendingIngressTexts, sessionKey);
          api.logger.debug(`mymem：自动捕获已跳过，agent ${agentId} 不在 captureAgents 白名单中`);
          return;
        }

        if (extractionRateLimiter.isRateLimited()) {
          api.logger.debug(
            `mymem：自动捕获已跳过（限流：最近一小时已有 ${extractionRateLimiter.getRecentCount()} 次提取）`,
          );
          return;
        }

        const accessibleScopes = resolveScopeFilter(scopeManager, agentId);
        const defaultScope = isSystemBypassId(agentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(agentId);

        api.logger.debug(
          `mymem：自动捕获收到 agent_end 载荷，agent=${agentId}（sessionKey=${sessionKey}，${summarizeAgentEndMessages(event.messages)}）`,
        );

        const eligibleItems: Array<{ role: "user" | "assistant"; text: string }> = [];
        let skippedAutoCaptureTexts = 0;
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;
          const rawRole = msgObj.role;
          if (rawRole !== "user" && rawRole !== "assistant") continue;
          const role = rawRole;

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

        const captureMaxMessages = Math.max(1, Math.min(50, Math.floor(config.captureMaxMessages ?? 32)));
        captureItems = captureItems.slice(-captureMaxMessages);
        const texts = textsOf(captureItems);
        if (skippedAutoCaptureTexts > 0) {
          api.logger.debug(`mymem：自动捕获跳过 ${skippedAutoCaptureTexts} 个注入/系统文本块，agent=${agentId}`);
        }
        if (pendingIngressTexts.length > 0) {
          api.logger.debug(`mymem：自动捕获使用 ${pendingIngressTexts.length} 条待处理入口文本，agent=${agentId}`);
        }
        if (texts.length !== eligibleTexts.length) {
          api.logger.debug(`mymem：自动捕获将 ${eligibleTexts.length} 条可用历史文本缩小为 ${texts.length} 条新文本，agent=${agentId}`);
        }
        api.logger.debug(`mymem：自动捕获收集到 ${texts.length} 条文本，agent=${agentId}（captureMaxMessages=${captureMaxMessages}，智能提取=${smartExtractor ? "开启" : "关闭"}）`);
        if (texts.length === 0) {
          api.logger.debug(`mymem：自动捕获过滤后没有可用文本，agent=${agentId}`);
          return;
        }

        if (!smartExtractor) {
          api.logger.debug(`mymem：自动捕获已跳过，agent=${agentId}（智能提取不可用，正则回退已关闭）`);
          return;
        }

        api.logger.debug(`mymem：自动捕获正在为 agent=${agentId} 运行智能提取（${captureItems.length} 条消息）`);
        const stats = await smartExtractor.extractAndPersist(
          formatConversationForSmartExtraction(captureItems),
          sessionKey,
          { scope: defaultScope, scopeFilter: accessibleScopes },
        );
        extractionRateLimiter.recordExtraction();
        if (stats.created > 0 || stats.merged > 0) {
          api.logger.info(`mymem：智能提取完成，agent=${agentId}，新建=${stats.created}，合并=${stats.merged}，跳过=${stats.skipped}`);
        }
      } catch (err) {
        api.logger.warn(`mymem：捕获失败：${String(err)}`);
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
