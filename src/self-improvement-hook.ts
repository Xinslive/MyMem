/**
 * Self-Improvement Hook Registration
 *
 * Registers hooks for self-improvement reminders and learning files.
 */

import { resolveWorkspaceDirFromContext } from "./path-utils.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";
import { loadSelfImprovementReminderContent } from "./session-recovery-utils.js";
import { containsErrorSignal, normalizeErrorSignature, redactSecrets, sha256Hex, summarizeErrorText, summarizeRecentConversationMessages } from "./session-utils.js";
import { isInternalReflectionSessionKey } from "./auto-capture-utils.js";
import { dedupHookEvent } from "./hook-dedup.js";
import type { PluginConfig } from "./plugin-types.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const RESET_REVIEW_MESSAGE_COUNT = 40;
const RESET_REVIEW_MAX_DETAILS_CHARS = 4_000;
const RESET_REVIEW_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_REVIEW_MAX_TRACKED_SESSIONS = 200;

const beforeResetReviewDedup = new Map<string, number>();

function containsLearningSignal(text: string): boolean {
  return /\b(actually|instead|wrong|correct(?:ion)?|fix(?:ed)?|learned|remember|avoid|from now on|going forward|should have|next time)\b/i.test(text) ||
    /不对|錯了|错了|應該是|应该是|改成|以后|以後|下次|避免|記住|记住/.test(text);
}

function clipDetails(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= RESET_REVIEW_MAX_DETAILS_CHARS
    ? trimmed
    : `${trimmed.slice(0, RESET_REVIEW_MAX_DETAILS_CHARS - 3)}...`;
}

function pruneBeforeResetReviewDedup(now = Date.now()): void {
  for (const [key, timestamp] of beforeResetReviewDedup.entries()) {
    if (now - timestamp > RESET_REVIEW_SESSION_TTL_MS) beforeResetReviewDedup.delete(key);
  }
  if (beforeResetReviewDedup.size <= RESET_REVIEW_MAX_TRACKED_SESSIONS) return;
  const overflow = beforeResetReviewDedup.size - RESET_REVIEW_MAX_TRACKED_SESSIONS;
  for (const key of beforeResetReviewDedup.keys()) {
    beforeResetReviewDedup.delete(key);
    if (beforeResetReviewDedup.size <= RESET_REVIEW_MAX_TRACKED_SESSIONS || beforeResetReviewDedup.size <= overflow) break;
  }
}

function createBeforeResetReviewKey(params: {
  type: "learning" | "error";
  sessionKey: string;
  sessionId: string;
  reason: string;
  conversation: string;
}): string {
  const normalized = params.type === "error"
    ? normalizeErrorSignature(params.conversation)
    : redactSecrets(params.conversation)
      .toLowerCase()
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  return [
    params.type,
    params.reason,
    params.sessionKey || params.sessionId || "unknown",
    sha256Hex(normalized).slice(0, 16),
  ].join(":");
}

function shouldWriteBeforeResetReview(key: string, now = Date.now()): boolean {
  pruneBeforeResetReviewDedup(now);
  if (beforeResetReviewDedup.has(key)) return false;
  beforeResetReviewDedup.set(key, now);
  return true;
}

function firstSignalLine(conversation: string, kind: "learning" | "error"): string {
  const lines = conversation
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const match = lines.find((line) => kind === "error" ? containsErrorSignal(line) : containsLearningSignal(line));
  return summarizeErrorText(match || conversation, 140);
}

export function registerSelfImprovementHook(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  isCliMode: () => boolean;
}): void {
  const { api, config, isCliMode } = params;

  if (config.selfImprovement?.enabled === false) {
    (isCliMode() ? api.logger.debug : api.logger.info)("self-improvement: disabled");
    return;
  }

  api.registerHook?.("agent:bootstrap", async (event) => {
    const context = (event.context || {}) as Record<string, unknown>;
    const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";

    if (isInternalReflectionSessionKey(sessionKey)) return;
    if (config.selfImprovement?.skipSubagentBootstrap !== false && sessionKey.includes(":subagent:")) return;
    if (dedupHookEvent("bootstrap", event)) return;

    try {
      const workspaceDir = resolveWorkspaceDirFromContext(context);
      if (config.selfImprovement?.ensureLearningFiles !== false) {
        await ensureSelfImprovementLearningFiles(workspaceDir);
      }

      const bootstrapFiles = context.bootstrapFiles;
      if (!Array.isArray(bootstrapFiles)) return;

      const exists = bootstrapFiles.some((f: any) => {
        if (!f || typeof f !== "object") return false;
        const pathValue = (f as Record<string, unknown>).path;
        return typeof pathValue === "string" && pathValue === "SELF_IMPROVEMENT_REMINDER.md";
      });
      if (exists) return;

      const content = await loadSelfImprovementReminderContent(workspaceDir);
      bootstrapFiles.push({ path: "SELF_IMPROVEMENT_REMINDER.md", content, virtual: true });
    } catch (err) {
      api.logger.warn(`self-improvement: bootstrap inject failed: ${String(err)}`);
    }
  }, {
    name: "mymem.self-improvement.agent-bootstrap",
    description: "Inject self-improvement reminder on agent bootstrap",
  });

  if (config.selfImprovement?.beforeResetNote !== false) {
    const captureBeforeReset = async (event: any, ctx: any = {}) => {
      const reason = String(event?.reason || "unknown");
      if (reason !== "new" && reason !== "reset") return;

      const sessionKey = typeof ctx?.sessionKey === "string"
        ? ctx.sessionKey
        : (typeof event?.sessionKey === "string" ? event.sessionKey : "");
      if (isInternalReflectionSessionKey(sessionKey)) return;
      if (dedupHookEvent("selfImprovementBeforeReset", { ...event, sessionKey })) return;

      try {
        const context = ctx && typeof ctx === "object" ? ctx : (event?.context || {});
        const workspaceDir = resolveWorkspaceDirFromContext(context as Record<string, unknown>);
        await ensureSelfImprovementLearningFiles(workspaceDir);

        const conversation = summarizeRecentConversationMessages(event?.messages ?? [], RESET_REVIEW_MESSAGE_COUNT);
        if (!conversation) {
          api.logger.debug(`self-improvement: before_reset:${reason} no conversation; skip capture`);
          return;
        }

        const hasError = containsErrorSignal(conversation);
        const hasLearning = containsLearningSignal(conversation);
        if (!hasError && !hasLearning) {
          api.logger.debug(`self-improvement: before_reset:${reason} no learning/error signal; skip capture`);
          return;
        }

        const sessionId = typeof ctx?.sessionId === "string" && ctx.sessionId.trim().length > 0
          ? ctx.sessionId.trim()
          : "unknown";
        const source = `mymem/before_reset:${reason}:${sessionId}`;
        const details = clipDetails([
          `Reason: ${reason}`,
          `Session Key: ${sessionKey || "(unknown)"}`,
          `Session ID: ${sessionId}`,
          "",
          "Recent conversation excerpt:",
          conversation,
        ].join("\n"));
        let writtenCount = 0;

        if (hasLearning) {
          const key = createBeforeResetReviewKey({ type: "learning", sessionKey, sessionId, reason, conversation });
          if (shouldWriteBeforeResetReview(key)) {
            await appendSelfImprovementEntry({
              baseDir: workspaceDir,
              type: "learning",
              summary: `Review possible learning before /${reason}: ${firstSignalLine(conversation, "learning")}`,
              details,
              suggestedAction: "Distill the reusable rule into AGENTS.md / SOUL.md / TOOLS.md or promote it to a skill if it repeats.",
              category: "best_practice",
              area: "workflow",
              priority: hasError ? "high" : "medium",
              status: "pending",
              source,
            });
            writtenCount++;
          } else {
            api.logger.debug(`self-improvement: before_reset:${reason} duplicate learning review skipped for session ${sessionId}`);
          }
        }

        if (hasError) {
          const key = createBeforeResetReviewKey({ type: "error", sessionKey, sessionId, reason, conversation });
          if (shouldWriteBeforeResetReview(key)) {
            await appendSelfImprovementEntry({
              baseDir: workspaceDir,
              type: "error",
              summary: `Review failure before /${reason}: ${firstSignalLine(conversation, "error")}`,
              details,
              suggestedAction: "Identify root cause and add a prevention rule or tool-specific gotcha if likely to recur.",
              area: "tools",
              priority: "high",
              status: "pending",
              source,
            });
            writtenCount++;
          } else {
            api.logger.debug(`self-improvement: before_reset:${reason} duplicate error review skipped for session ${sessionId}`);
          }
        }

        if (writtenCount > 0) {
          api.logger.info(`self-improvement: before_reset:${reason} captured ${writtenCount} review entr${writtenCount === 1 ? "y" : "ies"} for session ${sessionId}`);
        }
      } catch (err) {
        api.logger.warn(`self-improvement: before_reset capture failed: ${String(err)}`);
      }
    };

    api.on("before_reset", captureBeforeReset, { priority: 5 });
  }

  (isCliMode() ? api.logger.debug : api.logger.info)(
    "self-improvement: integrated hooks registered (agent:bootstrap, before_reset)"
  );
}
