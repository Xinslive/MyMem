/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate)
 * Inspired by openclaw-plugin-continuity's noise filtering approach.
 */

// Agent-side denial patterns (merged into single regex for O(1) matching)
const DENIAL_RE = /i don'?t have (any )?(information|data|memory|record)|i'?m not sure about|i don'?t recall|i don'?t remember|it looks like i don'?t|i wasn'?t able to find|no (relevant )?memories found|i don'?t have access to|我没有找到|我不确定|没有相关记忆|抱歉[，,]?我不记得|我无法确认|没有找到相关|我不太清楚/i;

// User-side meta-question patterns (about memory itself, not content)
const META_QUESTION_RE = /\bdo you (remember|recall|know about)\b|\bcan you (remember|recall)\b|\bdid i (tell|mention|say|share)\b|\bhave i (told|mentioned|said)\b|\bwhat did i (tell|say|mention)\b|如果你知道.+只回复|如果不知道.+只回复\s*none|只回复精确代号|只回复\s*none|你还?记得|记不记得|还记得.*吗|你[知晓]道.+吗|我(?:之前|上次|以前)(?:说|提|讲).*(?:吗|呢|？|\?)/i;

// Session boilerplate
const BOILERPLATE_RE = /^(hi|hello|hey|good morning|good evening|greetings)|^fresh session|^new session|^HEARTBEAT/i;

// Extractor artifacts from validation prompts / synthetic summaries
const DIAGNOSTIC_ARTIFACT_RE = /\bquery\s*->\s*(none|no explicit solution|unknown|not found)\b|\buser asked for\b.*\b(none|no explicit solution|unknown|not found)\b|\bno explicit solution\b/i;

// Reflection event metadata — pure anchors with no retrievable content
const REFLECTION_EVENT_RE = /^reflection-event\s*·/m;

/**
 * Envelope noise patterns — Discord/channel metadata headers and blocks
 * that have zero informational value for memory extraction.
 * Used as a fast pre-filter before embedding-based noise checks.
 */
export const ENVELOPE_NOISE_PATTERNS: RegExp[] = [
  /^<<<EXTERNAL_UNTRUSTED_CONTENT\b/im,
  /^<<<END_EXTERNAL_UNTRUSTED_CONTENT\b/im,
  /^Sender\s*\(untrusted metadata\):/im,
  /^Conversation info\s*\(untrusted metadata\):/im,
  /^Thread starter\s*\(untrusted, for context\):/im,
  /^Forwarded message context\s*\(untrusted metadata\):/im,
  /^\[Queued messages while agent was busy\]/im,
  /^System:\s*\[[\d\-: +GMT]+\]/im,  // precise: must match timestamp format
];

export interface NoiseFilterOptions {
  /** Filter agent denial responses (default: true) */
  filterDenials?: boolean;
  /** Filter meta-questions about memory (default: true) */
  filterMetaQuestions?: boolean;
  /** Filter session boilerplate (default: true) */
  filterBoilerplate?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
  filterDenials: true,
  filterMetaQuestions: true,
  filterBoilerplate: true,
};

/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();

  if (trimmed.length < 5) return true;

  if (opts.filterDenials && DENIAL_RE.test(trimmed)) return true;
  if (opts.filterMetaQuestions && META_QUESTION_RE.test(trimmed)) return true;
  if (opts.filterBoilerplate && BOILERPLATE_RE.test(trimmed)) return true;
  if (DIAGNOSTIC_ARTIFACT_RE.test(trimmed)) return true;
  if (REFLECTION_EVENT_RE.test(trimmed)) return true;

  return false;
}

/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise<T>(
  items: T[],
  getText: (item: T) => string,
  options?: NoiseFilterOptions
): T[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return items.filter(item => !isNoise(getText(item), opts));
}
