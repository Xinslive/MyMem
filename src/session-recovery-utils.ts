/**
 * Session Recovery Utilities
 *
 * Helper functions for reading and recovering session conversations.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { sortFileNamesByMtimeDesc } from "./file-utils.js";
import { summarizeRecentConversationMessages } from "./session-utils.js";
import type { ReflectionErrorSignal } from "./plugin-types.js";
import { DEFAULT_SELF_IMPROVEMENT_REMINDER } from "./plugin-constants.js";

/**
 * Loads self-improvement reminder content from workspace or returns default.
 */
export async function loadSelfImprovementReminderContent(workspaceDir?: string): Promise<string> {
  const baseDir = typeof workspaceDir === "string" && workspaceDir.trim().length ? workspaceDir.trim() : "";
  if (!baseDir) return DEFAULT_SELF_IMPROVEMENT_REMINDER;

  const reminderPath = join(baseDir, "SELF_IMPROVEMENT_REMINDER.md");
  try {
    const content = await readFile(reminderPath, "utf-8");
    const trimmed = content.trim();
    return trimmed.length ? trimmed : DEFAULT_SELF_IMPROVEMENT_REMINDER;
  } catch {
    return DEFAULT_SELF_IMPROVEMENT_REMINDER;
  }
}

/**
 * Reads session conversation from a file for reflection.
 */
export async function readSessionConversationForReflection(
  filePath: string,
  messageCount: number,
): Promise<string | null> {
  try {
    const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
    const messages: unknown[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || !entry?.message) continue;
        messages.push(entry.message);
      } catch {
        // ignore JSON parse errors
      }
    }

    return summarizeRecentConversationMessages(messages, messageCount);
  } catch {
    return null;
  }
}

/**
 * Reads session conversation with fallback to reset files.
 */
export async function readSessionConversationWithResetFallback(
  sessionFilePath: string,
  messageCount: number,
): Promise<string | null> {
  const primary = await readSessionConversationForReflection(sessionFilePath, messageCount);
  if (primary) return primary;

  try {
    const dir = dirname(sessionFilePath);
    const resetPrefix = `${basename(sessionFilePath)}.reset.`;
    const files = await readdir(dir);
    const resetCandidates = await sortFileNamesByMtimeDesc(
      dir,
      files.filter((name) => name.startsWith(resetPrefix))
    );
    if (resetCandidates.length > 0) {
      const latestResetPath = join(dir, resetCandidates[0]);
      return await readSessionConversationForReflection(latestResetPath, messageCount);
    }
  } catch {
    // ignore
  }

  return primary;
}

/**
 * Ensures a daily log file exists.
 */
export async function ensureDailyLogFile(dailyPath: string, dateStr: string): Promise<void> {
  try {
    await readFile(dailyPath, "utf-8");
  } catch {
    await writeFile(dailyPath, `# ${dateStr}\n\n`, "utf-8");
  }
}

/**
 * Builds a reflection prompt from conversation text.
 */
export function buildReflectionPrompt(
  conversation: string,
  maxInputChars: number,
  toolErrorSignals: ReflectionErrorSignal[] = [],
): string {
  const clipped = conversation.slice(-maxInputChars);
  const errorHints = toolErrorSignals.length > 0
    ? toolErrorSignals
      .map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary} (sig:${e.signatureHash.slice(0, 8)})`)
      .join("\n")
    : "- (none)";
  return `You are a helpful assistant with memory-reflection capabilities. Your task is to analyze the following conversation and extract key learnings, decisions, and patterns that should be captured for future reference.

## Conversation
${clipped}

## Reflection Instructions
1. Analyze the conversation and identify:
   - Key decisions made (what was decided, why, and implications)
   - Important facts or context that was established
   - User preferences or patterns in how they work
   - Any errors or issues that were encountered and how they were resolved
   - Best practices or approaches discovered

2. For each finding:
   - Provide a clear, specific summary
   - Explain why this information is important to remember
   - Note any action items or follow-ups

3. If there were tool errors, also consider what could be improved:
${errorHints}

4. Format your output as a structured reflection with clear sections for:
   - Decisions and their rationale
   - Key facts and context
   - User preferences
   - Issues encountered and resolutions
   - Potential improvements

Be concise but thorough. Focus on information that would be genuinely useful in future sessions.`;
}

/**
 * Builds fallback text when reflection generation fails.
 */
export function buildReflectionFallbackText(): string {
  return `Session reflection was requested but no meaningful conversation content was available for analysis.
This may happen with very short sessions or when session history is unavailable.
In future sessions, ensure meaningful conversation context is captured before requesting reflection.`;
}
