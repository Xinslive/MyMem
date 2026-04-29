/**
 * Hybrid Noise Detector
 *
 * Combines two complementary noise detection approaches:
 * 1. **Regex pre-check** — fast, synchronous, pattern-based (denials, meta-questions, boilerplate)
 * 2. **Embedding semantic check** — slower but catches nuanced noise missed by patterns
 *
 * Key improvement over separate systems:
 * - Regex matches are automatically learned to the prototype bank, so subsequent
 *   semantically similar noise is caught by the embedding check without regex.
 * - Unified API hides implementation details from callers.
 *
 * Architecture:
 *   check(text) → [regex match?] → [embedding match?] → NoiseDetectionResult
 *   learnFromRegex(text) → embed → NoisePrototypeBank.learn()
 */

import type { Embedder } from "./embedder.js";
import { isNoise as isNoiseRegex, filterNoise, ENVELOPE_NOISE_PATTERNS } from "./noise-filter.js";
import { NoisePrototypeBank } from "./noise-prototypes.js";

// ============================================================================
// Types
// ============================================================================

export interface NoiseDetectionResult {
  /** Whether the text is classified as noise */
  isNoise: boolean;
  /** Which detection method(s) flagged the text */
  detectionMethods: ("regex" | "embedding")[];
  /** Matching regex pattern name (if regex matched) */
  regexMatch?: "denial" | "meta-question" | "boilerplate" | "artifact";
  /** Cosine similarity to nearest noise prototype (if embedding matched) */
  embeddingSimilarity?: number;
  /** Whether this match should be learned to the prototype bank */
  shouldLearn: boolean;
}

/** Lightweight result for batch checking (no embedding similarity details) */
export interface NoiseCheckResult {
  isNoise: boolean;
  detectionMethods: ("regex" | "embedding")[];
  shouldLearn: boolean;
}

// ============================================================================
// HybridNoiseDetector
// ============================================================================

export class HybridNoiseDetector {
  private readonly regexOnly: boolean;
  private readonly noiseBank: NoisePrototypeBank;
  private readonly embedder: Embedder | null;
  private readonly learnFromRegex: boolean;
  private debugLog: (msg: string) => void;

  /**
   * @param embedder - Optional embedder for semantic noise detection.
   *                   If omitted, only regex-based detection is used.
   * @param noiseBank - Optional noise prototype bank. If omitted, a new one is created.
   * @param options - Configuration options
   */
  constructor(
    embedder?: Embedder | null,
    noiseBank?: NoisePrototypeBank | null,
    options: {
      /** Learn from regex-detected noise by adding to prototype bank (default: true) */
      learnFromRegex?: boolean;
      /** Log debug messages (default: no-op) */
      debugLog?: (msg: string) => void;
    } = {},
  ) {
    this.embedder = embedder ?? null;
    this.noiseBank = noiseBank ?? new NoisePrototypeBank();
    this.learnFromRegex = options.learnFromRegex ?? true;
    this.debugLog = options.debugLog ?? (() => {});
    this.regexOnly = !this.embedder;
  }

  /**
   * Whether the detector has embedding capabilities initialized.
   */
  get hasEmbeddingSupport(): boolean {
    return this.noiseBank.initialized;
  }

  /**
   * Initialize the embedding-based noise bank.
   * Call once at plugin startup. Safe to call multiple times (no-op after first).
   */
  async init(): Promise<void> {
    if (!this.embedder) return;
    await this.noiseBank.init(this.embedder);
  }

  /**
   * Fast synchronous check using only regex patterns.
   * Use this when embedding check is not needed or unavailable.
   */
  isNoiseRegex(text: string): boolean {
    return isNoiseRegex(text);
  }

  /**
   * Check if text matches envelope noise patterns (Discord/channel metadata headers).
   * Fast synchronous check for structural noise, not semantic noise.
   */
  isEnvelopeNoise(text: string): boolean {
    return ENVELOPE_NOISE_PATTERNS.some(p => p.test(text));
  }

  /**
   * Detailed noise detection with full result breakdown.
   * Uses both regex and (if available) embedding-based detection.
   *
   * @param text - The text to check
   * @param learnOnRegexMatch - Whether to learn regex matches to prototype bank (default: this.learnFromRegex)
   * @returns Detailed detection result
   */
  async check(text: string, learnOnRegexMatch = this.learnFromRegex): Promise<NoiseDetectionResult> {
    const trimmed = text.trim();
    const detectionMethods: ("regex" | "embedding")[] = [];
    let regexMatch: NoiseDetectionResult["regexMatch"];
    let shouldLearn = false;

    // Step 1: Fast regex check
    const regexResult = this.checkRegex(trimmed);
    if (regexResult.isNoise) {
      detectionMethods.push("regex");
      regexMatch = regexResult.matchType;
      shouldLearn = true; // Regex matches are learnable
    }

    // Step 2: Embedding check (if available and not already flagged)
    let embeddingSimilarity: number | undefined;
    if (this.noiseBank.initialized && !regexResult.isNoise) {
      const embeddingResult = await this.checkEmbedding(trimmed);
      if (embeddingResult.isNoise) {
        detectionMethods.push("embedding");
        embeddingSimilarity = embeddingResult.similarity;
        // Embedding matches from prototype bank don't need re-learning
        shouldLearn = false;
      }
    }

    const isNoise = detectionMethods.length > 0;

    // Step 3: Learn from regex match if configured and regex matched
    if (isNoise && detectionMethods.includes("regex") && learnOnRegexMatch && this.learnFromRegex) {
      await this.learnFromRegexMatch(trimmed);
    }

    return {
      isNoise,
      detectionMethods,
      regexMatch,
      embeddingSimilarity,
      shouldLearn,
    };
  }

  /**
   * Batch noise check for multiple texts.
   * More efficient than individual checks when many texts need processing.
   *
   * @param texts - Array of texts to check
   * @param learnOnRegexMatch - Whether to learn regex matches (default: true)
   * @returns Array of noise check results (same order as input)
   */
  async checkBatch(texts: string[], learnOnRegexMatch = true): Promise<NoiseCheckResult[]> {
    if (texts.length === 0) return [];

    const results: NoiseCheckResult[] = new Array(texts.length);
    const textsToEmbed: { index: number; text: string }[] = [];
    const regexFlags: boolean[] = new Array(texts.length);

    // Step 1: Fast regex pass on all texts
    for (let i = 0; i < texts.length; i++) {
      const trimmed = texts[i].trim();
      const regexResult = this.checkRegex(trimmed);
      regexFlags[i] = regexResult.isNoise;

      if (regexResult.isNoise) {
        results[i] = {
          isNoise: true,
          detectionMethods: ["regex"],
          shouldLearn: true,
        };

        // Learn from regex match if configured
        if (learnOnRegexMatch && this.learnFromRegex) {
          this.learnFromRegexMatch(trimmed).catch(() => {}); // Fire and forget
        }
      } else {
        // Defer to embedding check or mark clean for now
        textsToEmbed.push({ index: i, text: trimmed });
      }
    }

    // Step 2: Batch embedding check for non-regex-matched texts
    if (textsToEmbed.length > 0 && this.noiseBank.initialized && this.embedder) {
      const embeddingTexts = textsToEmbed.map(t => t.text);
      try {
        const vectors = await this.embedder.embedBatch(embeddingTexts);

        for (let i = 0; i < textsToEmbed.length; i++) {
          const { index } = textsToEmbed[i];
          const vec = vectors[i];

          if (!vec || vec.length === 0) {
            // Embedding failed, conservatively mark as clean
            results[index] = {
              isNoise: false,
              detectionMethods: [],
              shouldLearn: false,
            };
            continue;
          }

          const isNoiseEmbedding = this.noiseBank.isNoise(vec);
          if (isNoiseEmbedding) {
            results[index] = {
              isNoise: true,
              detectionMethods: ["embedding"],
              shouldLearn: false,
            };
          } else {
            results[index] = {
              isNoise: false,
              detectionMethods: [],
              shouldLearn: false,
            };
          }
        }
      } catch (err) {
        // Embedding API failed, mark all as clean
        this.debugLog(`HybridNoiseDetector.checkBatch: embedding failed - ${err}`);
        for (const { index } of textsToEmbed) {
          results[index] = {
            isNoise: false,
            detectionMethods: [],
            shouldLearn: false,
          };
        }
      }
    } else {
      // No embedding support, mark remaining as clean
      for (const { index } of textsToEmbed) {
        results[index] = {
          isNoise: false,
          detectionMethods: [],
          shouldLearn: false,
        };
      }
    }

    return results;
  }

  /**
   * Filter an array of items using hybrid noise detection.
   * Uses batch embedding when available for efficiency.
   */
  async filter<T>(
    items: T[],
    getText: (item: T) => string,
  ): Promise<T[]> {
    if (items.length === 0) return items;

    const texts = items.map(getText);
    const results = await this.checkBatch(texts, false); // Don't learn during filtering

    return items.filter((_, index) => !results[index].isNoise);
  }

  /**
   * Learn a text from a regex match to the prototype bank.
   * Called internally when learnFromRegex is enabled.
   * Also available for external callers who want to manually trigger learning.
   */
  async learnFromRegexMatch(text: string): Promise<void> {
    if (!this.embedder || !this.noiseBank.initialized) return;

    try {
      const vec = await this.embedder.embed(text);
      if (vec && vec.length > 0) {
        this.noiseBank.learn(vec);
        this.debugLog(`HybridNoiseDetector: learned noise from regex match: "${text.slice(0, 50)}..."`);
      }
    } catch (err) {
      this.debugLog(`HybridNoiseDetector: failed to learn from regex match - ${err}`);
    }
  }

  /**
   * Manually add a text to the noise prototype bank.
   * Useful for explicit feedback loop integration.
   */
  async learnNoise(text: string): Promise<void> {
    await this.learnFromRegexMatch(text);
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private checkRegex(text: string): { isNoise: boolean; matchType?: NoiseDetectionResult["regexMatch"] } {
    const trimmed = text.trim();

    // Quick length check
    if (trimmed.length < 5) {
      return { isNoise: true, matchType: "artifact" };
    }

    // Check denial patterns
    if (/i don'?t have (any )?(information|data|memory|record)/i.test(trimmed) ||
        /i'?m not sure about/i.test(trimmed) ||
        /i don'?t recall/i.test(trimmed) ||
        /i don'?t remember/i.test(trimmed) ||
        /it looks like i don'?t/i.test(trimmed) ||
        /i wasn'?t able to find/i.test(trimmed) ||
        /no (relevant )?memories found/i.test(trimmed) ||
        /i don'?t have access to/i.test(trimmed)) {
      return { isNoise: true, matchType: "denial" };
    }

    // Check meta-question patterns
    if (/\bdo you (remember|recall|know about)\b/i.test(trimmed) ||
        /\bcan you (remember|recall)\b/i.test(trimmed) ||
        /\bdid i (tell|mention|say|share)\b/i.test(trimmed) ||
        /\bhave i (told|mentioned|said)\b/i.test(trimmed) ||
        /\bwhat did i (tell|say|mention)\b/i.test(trimmed) ||
        /如果你知道.+只回复/i.test(trimmed) ||
        /如果不知道.+只回复\s*none/i.test(trimmed) ||
        /只回复精确代号/i.test(trimmed) ||
        /只回复\s*none/i.test(trimmed) ||
        /你还?记得/.test(trimmed) ||
        /记不记得/.test(trimmed) ||
        /还记得.*吗/.test(trimmed) ||
        /你[知晓]道.+吗/.test(trimmed) ||
        /我(?:之前|上次|以前)(?:说|提|讲).*(?:吗|呢|？|\?)/.test(trimmed)) {
      return { isNoise: true, matchType: "meta-question" };
    }

    // Check boilerplate patterns
    if (/^(hi|hello|hey|good morning|good evening|greetings)/i.test(trimmed) ||
        /^fresh session/i.test(trimmed) ||
        /^new session/i.test(trimmed) ||
        /^HEARTBEAT/i.test(trimmed)) {
      return { isNoise: true, matchType: "boilerplate" };
    }

    // Check diagnostic artifact patterns
    if (/\bquery\s*->\s*(none|no explicit solution|unknown|not found)\b/i.test(trimmed) ||
        /\buser asked for\b.*\b(none|no explicit solution|unknown|not found)\b/i.test(trimmed) ||
        /\bno explicit solution\b/i.test(trimmed)) {
      return { isNoise: true, matchType: "artifact" };
    }

    return { isNoise: false };
  }

  private async checkEmbedding(text: string): Promise<{ isNoise: boolean; similarity?: number }> {
    if (!this.embedder || !this.noiseBank.initialized) {
      return { isNoise: false };
    }

    try {
      const vec = await this.embedder.embed(text);
      if (!vec || vec.length === 0) {
        return { isNoise: false };
      }

      // Find max similarity to any prototype
      let maxSimilarity = 0;
      for (const proto of (this.noiseBank as any).vectors) {
        const sim = cosineSimilarity(proto, vec);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }

      const threshold = 0.82; // From NoisePrototypeBank.DEFAULT_THRESHOLD
      return {
        isNoise: maxSimilarity >= threshold,
        similarity: maxSimilarity,
      };
    } catch {
      return { isNoise: false };
    }
  }
}

// ============================================================================
// Cosine Similarity (duplicated from noise-prototypes.ts to avoid circular dep)
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Re-export for backward compatibility
// ============================================================================

/** @deprecated Use HybridNoiseDetector.isNoiseRegex() instead */
export { isNoiseRegex as isNoise };

/** @deprecated Use HybridNoiseDetector.check() instead */
export { filterNoise };

/** @deprecated Export noise bank for backward compatibility */
export { NoisePrototypeBank };

/** @deprecated Export envelope patterns for backward compatibility */
export { ENVELOPE_NOISE_PATTERNS };
