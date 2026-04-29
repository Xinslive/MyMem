/**
 * Plugin Constants
 *
 * Memory triggers, exclude patterns, and other constants.
 */

export const MEMORY_TRIGGERS = [
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

export const CAPTURE_EXCLUDE_PATTERNS = [
  // Memory management / meta-ops: do not store as long-term memory
  /\b(mymem|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+mymem\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];

export const DEFAULT_SELF_IMPROVEMENT_REMINDER = `## Self-Improvement Reminder

After completing tasks, evaluate if any learnings should be captured:

**Log when:**
- User corrects you -> .learnings/LEARNINGS.md
- Command/operation fails -> .learnings/ERRORS.md
- You discover your knowledge was wrong -> .learnings/LEARNINGS.md
- You find a better approach -> .learnings/LEARNINGS.md

**Promote when pattern is proven:**
- Behavioral patterns -> SOUL.md
- Workflow improvements -> AGENTS.md
- Tool gotchas -> TOOLS.md

Keep entries simple: date, title, what happened, what to do differently.`;

export const SELF_IMPROVEMENT_NOTE_PREFIX = "/note self-improvement (before reset):";
export const DEFAULT_REFLECTION_MESSAGE_COUNT = 120;
export const DEFAULT_REFLECTION_MAX_INPUT_CHARS = 24_000;
export const DEFAULT_REFLECTION_TIMEOUT_MS = 90_000;
export const DEFAULT_REFLECTION_THINK_LEVEL: "off" | "minimal" | "low" | "medium" | "high" = "medium";
export const DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES = 3;
export const DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS = true;
export const DEFAULT_REFLECTION_SESSION_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS = 200;
export const DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS = 8_000;
export const REFLECTION_FALLBACK_MARKER = "(fallback) Reflection generation failed; storing minimal pointer only.";
export const DIAG_BUILD_TAG = "mymem-diag-20260308-0058";
