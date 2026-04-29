/**
 * Envelope Metadata Stripping
 *
 * Strip platform envelope metadata injected by OpenClaw channels before
 * the conversation text reaches the extraction LLM. These envelopes contain
 * message IDs, sender IDs, timestamps, and JSON metadata blocks that have
 * zero informational value for memory extraction but get stored verbatim
 * by weaker LLMs (e.g. qwen) that can't distinguish metadata from content.
 *
 * Targets:
 * - "System: [YYYY-MM-DD HH:MM:SS GMT+N] Channel[account] ..." header lines
 * - "Conversation info (untrusted metadata):" + JSON code blocks
 * - "Sender (untrusted metadata):" + JSON code blocks
 * - "Replied message (untrusted, for context):" + JSON code blocks
 * - Standalone JSON blocks containing message_id/sender_id fields
 *
 * Note: stripLeadingRuntimeWrappers and stripRuntimeWrapperBoilerplate from
 * the old implementation are dead code after this refactor — they are not
 * called anywhere in the pipeline. They have been removed.
 */
export function stripEnvelopeMetadata(text: string): string {
  // Matches wrapper lines: [Subagent Context] or [Subagent Task], possibly with
  // inline content on the same line (e.g. "[Subagent Task] Reply with brief ack.").
  // Also matches when the wrapper prefix is on its own line ("]\n" = no content after ]).
  const WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\](?:\s|$|\n)?/i;
  const BOILERPLATE_RE = /^(?:Results auto-announce to your requester\.?|do not busy-poll for status\.?|Reply with a brief acknowledgment only\.?|Do not use any memory tools\.?)$/im;
  // Anchored inline variant: only strip boilerplate when it starts the wrapper
  // remainder. This avoids erasing legitimate inline payload that merely quotes
  // a boilerplate phrase later in the sentence.
  // Repeat the anchored segment so composite wrappers like "You are running...
  // Results auto-announce..." are fully removed before preserving any payload.
  // The subagent running phrase uses (?<=\.)\s+|$ alternation (same as old
  // RUNTIME_WRAPPER_BOILERPLATE_RE) so that parenthetical depth like "(depth 1/1)."
  // is included before the ending whitespace, correctly stripping the full phrase.
  const INLINE_BOILERPLATE_RE =
    /^(?:(?:You are running as a subagent\b.*?(?:(?<=\.)\s+|$)|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*))+/i;
  // Anchor to start of line — prevents quoted/cited false-positives
  const SUBAGENT_RUNNING_RE = /^You are running as a subagent\b/i;

  const originalLines = text.split("\n");

  // Pre-scan: determine if there are leading wrappers.
  // Needed to decide whether boilerplate in the leading zone should be stripped
  // (boilerplate without a wrapper prefix is preserved — it may be legitimate user text).
  //
  // FIX (Must Fix 2): Only scan the ACTUAL leading zone — lines before the first
  // real user content. Previously scanned ALL lines, causing false positives when
  // a wrapper appeared in the trailing zone (e.g. user-pasted quoted text).
  let foundLeadingWrapper = false;
  for (let i = 0; i < originalLines.length; i++) {
    const trimmed = originalLines[i].trim();
    if (trimmed === "") continue; // blank lines are part of leading zone
    if (WRAPPER_LINE_RE.test(trimmed)) { foundLeadingWrapper = true; continue; }
    if (BOILERPLATE_RE.test(trimmed)) continue;
    // First real user content — stop scanning, this is the leading zone boundary
    break;
  }

  // Single-pass state machine: find leading zone end and build result simultaneously.
  // Key: "You are running as a subagent..." on its own line AFTER a wrapper prefix
  // is wrapper CONTENT (must be stripped), not user content.
  let stillInLeadingZone = true;
  let prevWasWrapper = false;
  let encounteredWrapperYet = false; // FIX (MAJOR): per-line flag, not global
  const result: string[] = [];

  for (let i = 0; i < originalLines.length; i++) {
    const rawLine = originalLines[i];
    const trimmed = rawLine.trim();
    const isWrapper = WRAPPER_LINE_RE.test(trimmed);
    const isBoilerplate = BOILERPLATE_RE.test(trimmed);
    const afterPrefix = trimmed.replace(WRAPPER_LINE_RE, "").trim();
    const isBoilerplateAfterPrefix = BOILERPLATE_RE.test(afterPrefix);
    const isSubagentContent = prevWasWrapper && SUBAGENT_RUNNING_RE.test(trimmed);

    // Strip wrapper lines only when inside the leading zone (N2 fix)
    if (stillInLeadingZone && isWrapper) {
      prevWasWrapper = true;
      encounteredWrapperYet = true;
      // 1. Strip wrapper prefix
      let remainder = afterPrefix;
      // 2. Remove all boilerplate phrases from remainder (handles inline
      //    wrapper+boilerplate like "[Subagent Context] ... Results auto-announce...").
      //    Use INLINE_BOILERPLATE_RE (anchored, includes subagent phrase) so only
      //    leading wrapper boilerplate is removed while quoted user payload remains.
      remainder = remainder.replace(INLINE_BOILERPLATE_RE, "").replace(/\s{2,}/g, " ").trim();
      // 3. Keep remainder if non-empty (non-boilerplate inline content preserved);
      //    strip the whole line if only boilerplate was present
      result.push(remainder);
      continue;
    }

    if (stillInLeadingZone) {
      // Blank line — strip but do NOT exit the leading zone (Must Fix 1 fix)
      if (trimmed === "") {
        result.push("");
        continue;
      }

      // Boilerplate check: use afterPrefix (wrapper-stripped content) so that
      // inline wrapper+boilerplate like "[Subagent Task] Reply with brief ack."
      // is correctly identified as boilerplate and removed.
      const contentForBoilerplateCheck = isWrapper ? afterPrefix : trimmed;
      const isBoilerplateInline = BOILERPLATE_RE.test(contentForBoilerplateCheck);

      if (isBoilerplateInline) {
        // Boilerplate in leading zone — strip only when a wrapper has ALREADY
        // appeared on a PREVIOUS line. This correctly handles the case where
        // boilerplate text appears BEFORE the first wrapper in the leading zone
        // (e.g. legitimate user text matching a boilerplate phrase, followed
        // later by a wrapper).
        result.push(encounteredWrapperYet ? "" : rawLine);
        continue;
      }

      if (isSubagentContent) {
        // Multiline wrapper: "You are running as a subagent..." on its own line
        // after a wrapper prefix — strip it; keep prevWasWrapper true
        result.push(""); // strip
        continue;
      }

      // Real user content — exit the leading zone permanently
      stillInLeadingZone = false;
      prevWasWrapper = false;
      encounteredWrapperYet = false;
      result.push(rawLine); // preserve
      continue;
    }

    // After leaving leading zone — always preserve
    result.push(rawLine);
  }

  let cleaned = result.join("\n");

  // 1. Strip "System: [timestamp] Channel..." lines
  cleaned = cleaned.replace(
    /^System:\s*\[[\d\-: +GMT]+\]\s+\S+\[.*?\].*$/gm,
    "",
  );

  // 2. Strip labeled metadata sections with their JSON code blocks
  //    e.g. "Conversation info (untrusted metadata):\n```json\n{...}\n```"
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Replied message)\s*\(untrusted[^)]*\):\s*```json\s*\{[\s\S]*?\}\s*```/g,
    "",
  );

  // 3. Strip any remaining JSON blocks that look like envelope metadata
  //    (contain message_id and sender_id fields)
  cleaned = cleaned.replace(
    /```json\s*(?=\{[\s\S]*?"message_id"\s*:)(?=\{[\s\S]*?"sender_id"\s*:)\{[\s\S]*?\}\s*```/g,
    "",
  );

  // 4. Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
