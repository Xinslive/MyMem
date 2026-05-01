/**
 * Memory Capture Detection
 *
 * Determines whether a message should be captured as a memory entry
 * and what category it belongs to.
 */

import { isNoise } from "./noise-filter.js";

/**
 * Patterns that indicate a message should be captured as memory.
 */
const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
  // Chinese triggers (Traditional & Simplified)
  /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
  /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
  /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
  /我的\S+是|叫我|稱呼|称呼/,
  /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
  /重要|關鍵|关键|注意|千萬別|千万别/,
  /幫我|筆記|存檔|存起來|存一下|重點|原則|底線/,
];

/**
 * Patterns that indicate a message should NOT be captured.
 */
const CAPTURE_EXCLUDE_PATTERNS = [
  // Memory management / meta-ops: do not store as long-term memory
  /\b(mymem|mymem_store|mymem_recall|mymem_forget|mymem_update)\b/i,
  /\bopenclaw\s+mymem\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];

/**
 * Determines if a message should be captured as memory.
 */
export function shouldCapture(text: string): boolean {
  let s = text.trim();

  // Strip OpenClaw metadata headers (Conversation info or Sender)
  const metadataPattern = /^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim;
  s = s.replace(metadataPattern, "");

  // CJK characters carry more meaning per character, use lower minimum threshold
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
  const minLen = hasCJK ? 4 : 10;
  if (s.length < minLen || s.length > 500) {
    return false;
  }

  // Skip injected context from memory recall
  if (s.includes("<relevant-memories>")) {
    return false;
  }

  // Skip system-generated content
  if (s.startsWith("<") && s.includes("</")) {
    return false;
  }

  // Skip agent summary responses (contain markdown formatting)
  if (s.includes("**") && s.includes("\n-")) {
    return false;
  }

  // Skip emoji-heavy responses (likely agent output)
  const emojiCount = (s.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }

  // Exclude obvious memory-management prompts
  if (CAPTURE_EXCLUDE_PATTERNS.some((r) => r.test(s))) return false;

  return MEMORY_TRIGGERS.some((r) => r.test(s));
}

/**
 * Detects the category of a memory entry based on its content.
 */
export function detectCategory(
  text: string,
): "preference" | "fact" | "decision" | "entity" | "other" {
  const lower = text.toLowerCase();

  if (
    /prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛好|爱用|習慣|习惯/i.test(
      lower,
    )
  ) {
    return "preference";
  }

  if (
    /rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|流程|SOP/i.test(
      lower,
    )
  ) {
    return "decision";
  }

  if (
    /\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(
      lower,
    )
  ) {
    return "entity";
  }

  if (
    /\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(
      lower,
    )
  ) {
    return "fact";
  }

  return "other";
}

/**
 * Sanitizes text for safe inclusion in context injection.
 */
export function sanitizeForContext(text: string): string {
  return text
    .replace(/[\r\n]+/g, "\\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/</g, "\uFF1C")
    .replace(/>/g, "\uFF1E")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Summarizes text preview for logging/debugging.
 */
export function summarizeTextPreview(text: string, maxLen = 120): string {
  return JSON.stringify(sanitizeForContext(text).slice(0, maxLen));
}

/**
 * Summarizes message content for logging.
 */
export function summarizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return `string(len=${trimmed.length}, preview=${summarizeTextPreview(trimmed)})`;
  }

  if (Array.isArray(content)) {
    const textBlocks: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        textBlocks.push((block as Record<string, unknown>).text as string);
      }
    }
    const combined = textBlocks.join(" ").trim();
    return `array(blocks=${content.length}, textBlocks=${textBlocks.length}, textLen=${combined.length}, preview=${summarizeTextPreview(combined)})`;
  }

  return `type=${Array.isArray(content) ? "array" : typeof content}`;
}

/**
 * Summarizes capture decision for logging.
 */
export function summarizeCaptureDecision(text: string): string {
  const trimmed = text.trim();
  const preview = sanitizeForContext(trimmed).slice(0, 120);
  return `len=${trimmed.length}, trigger=${shouldCapture(trimmed) ? "Y" : "N"}, noise=${isNoise(trimmed) ? "Y" : "N"}, preview=${JSON.stringify(preview)}`;
}
