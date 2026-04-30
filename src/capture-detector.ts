/**
 * Capture Detection Utilities
 *
 * Re-exports from capture-detection.ts for backward compatibility.
 * Canonical implementations live in capture-detection.ts.
 */
export {
  shouldCapture,
  detectCategory,
  sanitizeForContext,
  summarizeTextPreview,
  summarizeMessageContent,
  summarizeCaptureDecision,
} from "./capture-detection.js";
