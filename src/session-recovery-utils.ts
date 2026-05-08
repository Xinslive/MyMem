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
  return `You are a helpful assistant with memory-reflection capabilities. Your task is to analyze the following conversation and extract key learnings, decisions, and patterns that should be captured for future reference. If the conversation does not contain durable, future-useful information, it is acceptable to extract nothing; do not invent or force memories.

## Conversation
${clipped}

## Reflection Instructions
1. Analyze the conversation and identify:
   - Key decisions made (what was decided, why, and implications)
   - Important facts or context that was established
   - User preferences or patterns in how they work
   - Any errors or issues that were encountered and how they were resolved
   - Best practices or approaches discovered

Only attribute preferences, intentions, or decisions to the user when the user explicitly said, confirmed, or restated them. If the assistant suggested an approach in response to the user's confusion, do not summarize that suggestion as the user's preference or plan unless the user accepted it.
如果用户只是提出困惑，而助手给出建议，不要把助手建议总结成“用户想要/偏好/决定”；只有用户明确确认或复述为自己的意图时才可这样归因。

2. For each finding:
   - Provide a clear, specific summary
   - Explain why this information is important to remember
   - Note any action items or follow-ups

3. If there were tool errors, also consider what could be improved:
${errorHints}

4. If there is no valuable content to preserve, say so briefly and leave the extraction sections empty or marked as none.

5. Format your output as a structured reflection with clear sections for:
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
