import { stripEnvelopeMetadata } from "./envelope-stripping.js";
import { redactSecrets } from "./session-utils.js";

/**
 * Shared sanitizer for text that is about to become durable memory data.
 *
 * It intentionally preserves ordinary PII (emails, paths, names) because those
 * can be valid memories, but strips platform envelopes and true credentials.
 */
export function sanitizeMemoryWriteText(text: string): string {
  return redactSecrets(stripEnvelopeMetadata(text));
}
