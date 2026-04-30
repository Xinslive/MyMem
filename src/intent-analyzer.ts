/**
 * Intent Analyzer for Adaptive Recall
 *
 * Lightweight, rule-based intent analysis that determines which memory categories
 * are most relevant for a given query and what recall depth to use.
 *
 * Inspired by OpenViking's hierarchical retrieval intent routing, adapted for
 * mymem's flat category model. No LLM calls — pure pattern matching
 * for minimal latency impact on auto-recall.
 *
 * @see https://github.com/volcengine/OpenViking — hierarchical_retriever.py intent analysis
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Intent categories map to actual stored MemoryEntry categories.
 * Note: "event" is NOT a stored category — event queries route to
 * entity + decision (the categories most likely to contain timeline data).
 */
export type MemoryCategoryIntent =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "other";

export type RecallDepth = "l0" | "l1" | "full";

/**
 * Knowledge vs Experience routing (arxiv:2602.05665 §V-E).
 * Set from per-intent-rule hints; consumed by applyMemoryTypeBoost to
 * promote the matching side of the split.
 */
export type MemoryTypeIntent = "knowledge" | "experience";

export interface IntentSignal {
  /** Categories to prioritize (ordered by relevance). */
  categories: MemoryCategoryIntent[];
  /** Recommended recall depth for this intent. */
  depth: RecallDepth;
  /** Confidence level of the intent classification. */
  confidence: "high" | "medium" | "low";
  /** Short label for logging. */
  label: string;
  /** Preferred memory type (knowledge vs experience), if the query leans one way. */
  memoryType?: MemoryTypeIntent;
}

// ============================================================================
// Intent Patterns
// ============================================================================

interface IntentRule {
  label: string;
  patterns: RegExp[];
  categories: MemoryCategoryIntent[];
  depth: RecallDepth;
  memoryType?: MemoryTypeIntent;
}

/**
 * Intent rules ordered by specificity (most specific first).
 * First match wins — keep high-confidence patterns at the top.
 */
const INTENT_RULES: IntentRule[] = [
  // --- Preference / Style queries ---
  {
    label: "preference",
    patterns: [
      /\b(prefer|preference|style|convention|like|dislike|favorite|habit)\b/i,
      /\b(how do (i|we) usually|what('s| is) (my|our) (style|convention|approach))\b/i,
      /(偏好|喜欢|习惯|风格|惯例|常用|不喜欢|不要用|别用)/,
      /(用\S+比较好|推荐用|倾向于|比较喜欢|更喜欢|最好用|一般用)/,
    ],
    categories: ["preference", "decision"],
    depth: "l0",
    memoryType: "knowledge",
  },

  // --- Experience / Trajectory queries (K-E decoupling, §V-E) ---
  // Kept above "decision" so queries like "last time we decided" route to
  // experience rather than generic decision-rationale.
  {
    label: "experience",
    patterns: [
      /\b(last time|remember when|recall when|when we (tried|did|built|shipped|deployed))\b/i,
      /\b(previously|earlier (we|i)|we used to|ran into|encountered)\b/i,
      /(上次|上回|之前|以前|记得|还记得|那次|那会|先前)/,
      /(当时|那一次|上次试过|曾经|试过|遇到过|碰到过|踩过坑)/,
    ],
    categories: ["decision", "fact"],
    depth: "full",
    memoryType: "experience",
  },

  // --- Decision / Rationale queries ---
  {
    label: "decision",
    patterns: [
      /\b(why did (we|i)|decision|decided|chose|rationale|trade-?off|reason for)\b/i,
      /\b(what was the (reason|rationale|decision))\b/i,
      /(为什么选|决定|选择了|取舍|权衡|原因是|当时决定)/,
      /(最终决定|方案是|确定用|定了用|选了|为啥选|为啥用|干嘛用|干吗选)/,
    ],
    categories: ["decision", "fact"],
    depth: "l1",
    memoryType: "experience",
  },

  // --- Entity / People / Project queries ---
  // Narrowed patterns to avoid over-matching: require "who is" / "tell me about"
  // style phrasing, not bare nouns like "tool" or "component".
  {
    label: "entity",
    patterns: [
      /\b(who is|who are|tell me about|info on|details about|contact info)\b/i,
      /\b(who('s| is) (the|our|my)|what team|which (person|team))\b/i,
      /(谁是|告诉我关于|详情|联系方式|哪个团队)/,
      /(谁负责|哪个团队在做|联系人是谁|谁在搞|谁弄的|谁写的)/,
    ],
    categories: ["entity", "fact"],
    depth: "l1",
    memoryType: "knowledge",
  },

  // --- Event / Timeline queries ---
  // Note: "event" is not a stored category. Route to entity + decision
  // (the categories most likely to contain timeline/incident data).
  {
    label: "event",
    patterns: [
      /\b(when did|what happened|timeline|incident|outage|deploy|release|shipped)\b/i,
      /\b(last (week|month|time|sprint)|recently|yesterday|today)\b/i,
      /(什么时候|发生了什么|时间线|事件|上线|部署|发布|最近)/,
      /(出了什么问题|故障|出了个\s*bug|挂了|崩了|炸了|宕机|报错了)/,
    ],
    categories: ["entity", "decision"],
    depth: "full",
    memoryType: "experience",
  },

  // --- Fact / Knowledge queries ---
  {
    label: "fact",
    patterns: [
      /\b(how (does|do|to)|what (does|do|is)|explain|documentation|spec)\b/i,
      /\b(config|configuration|setup|install|architecture|api|endpoint)\b/i,
      /(怎么|如何|是什么|解释|文档|规范|配置|安装|架构|接口|原理|规则)/,
      /(怎么用|怎么配|什么作用|怎么实现的|啥意思|干嘛的|有什么用)/,
    ],
    categories: ["fact", "entity"],
    depth: "l1",
    memoryType: "knowledge",
  },
];

// ============================================================================
// Analyzer
// ============================================================================

const DEPTH_RANK: Record<RecallDepth, number> = { l0: 0, l1: 1, full: 2 };

/**
 * Analyze a query to determine which memory categories and recall depth
 * are most appropriate.
 *
 * Collects ALL matching intent rules (not just the first) to support
 * composite queries like "上次我们为什么选择了 React" which combines
 * experience + decision intents. Merges categories (deduplicated) and
 * picks the deepest recall depth across matches.
 */
export function analyzeIntent(query: string): IntentSignal {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      categories: [],
      depth: "l0",
      confidence: "low",
      label: "empty",
    };
  }

  const matched: IntentRule[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => p.test(trimmed))) {
      matched.push(rule);
    }
  }

  if (matched.length === 0) {
    // No specific intent detected — return broad signal.
    return {
      categories: [],
      depth: "l0",
      confidence: "low",
      label: "broad",
    };
  }

  // Merge all matched rules: deduplicate categories, pick deepest depth
  const allCategories = [...new Set(matched.flatMap(r => r.categories))];
  const deepest = matched.reduce<RecallDepth>((best, r) =>
    DEPTH_RANK[r.depth] > DEPTH_RANK[best] ? r.depth : best, matched[0].depth);
  const memoryType = matched.find(r => r.memoryType)?.memoryType;

  return {
    categories: allCategories,
    depth: deepest,
    confidence: matched.length > 1 ? "high" : "medium",
    label: matched.map(r => r.label).join("+"),
    memoryType,
  };
}

/**
 * Apply intent-based category boost to retrieval results.
 *
 * Instead of filtering (which would lose potentially relevant results),
 * this boosts scores of results matching the detected intent categories.
 * Non-matching results are kept but ranked lower.
 *
 * @param results - Retrieval results with scores
 * @param intent - Detected intent signal
 * @param boostFactor - Score multiplier for matching categories (default: 1.15)
 * @returns Results with adjusted scores, re-sorted
 */
export function applyCategoryBoost<
  T extends { entry: { category: string }; score: number },
>(results: T[], intent: IntentSignal, boostFactor = 1.15): T[] {
  if (intent.categories.length === 0 || intent.confidence === "low") {
    return results; // No intent signal — return as-is
  }

  const prioritySet = new Set<string>(intent.categories);

  const boosted = results.map((r) => {
    if (prioritySet.has(r.entry.category)) {
      return { ...r, score: Math.min(1, r.score * boostFactor) };
    }
    return r;
  });

  return boosted.sort((a, b) => b.score - a.score);
}

/**
 * Boost results whose stored memory_type matches the intent's memoryType.
 *
 * Implements the retrieval half of knowledge-experience decoupling
 * (arxiv:2602.05665 §V-E). Call AFTER applyCategoryBoost so both signals
 * compound on the same result set.
 *
 * `getMemoryType` reads the stored type from entry metadata — accepting a
 * callback keeps this module free of JSON-parsing and smart-metadata imports.
 */
export function applyMemoryTypeBoost<
  T extends { entry: { metadata?: string }; score: number },
>(
  results: T[],
  intent: IntentSignal,
  getMemoryType: (entry: T["entry"]) => "knowledge" | "experience" | undefined,
  boostFactor = 1.15,
): T[] {
  if (!intent.memoryType || intent.confidence === "low") return results;

  const want = intent.memoryType;
  const boosted = results.map((r) => {
    const type = getMemoryType(r.entry);
    if (type === want) {
      return { ...r, score: Math.min(1, r.score * boostFactor) };
    }
    return r;
  });

  return boosted.sort((a, b) => b.score - a.score);
}

/**
 * Format a memory entry for context injection at the specified depth level.
 *
 * - l0: One-line summary (category + scope + truncated text)
 * - l1: Medium detail (category + scope + text up to ~300 chars)
 * - full: Complete text (existing behavior)
 */
export function formatAtDepth(
  entry: { text: string; category: string; scope: string },
  depth: RecallDepth,
  score: number,
  index: number,
  extra?: { bm25Hit?: boolean; reranked?: boolean; sanitize?: (text: string) => string },
): string {
  const scoreStr = `${(score * 100).toFixed(0)}%`;
  const sourceSuffix = [
    extra?.bm25Hit ? "vector+BM25" : null,
    extra?.reranked ? "+reranked" : null,
  ]
    .filter(Boolean)
    .join("");
  const sourceTag = sourceSuffix ? `, ${sourceSuffix}` : "";

  // Apply sanitization if provided (prevents prompt injection from stored memories)
  const safe = extra?.sanitize ? extra.sanitize(entry.text) : entry.text;

  switch (depth) {
    case "l0": {
      // Ultra-compact: first sentence or first 80 chars
      const brief = extractFirstSentence(safe, 80);
      return `- [${entry.category}] ${brief} (${scoreStr}${sourceTag})`;
    }
    case "l1": {
      // Medium: up to 300 chars
      const medium =
        safe.length > 300
          ? safe.slice(0, 297) + "..."
          : safe;
      return `- [${entry.category}:${entry.scope}] ${medium} (${scoreStr}${sourceTag})`;
    }
    case "full":
    default:
      return `- [${entry.category}:${entry.scope}] ${safe} (${scoreStr}${sourceTag})`;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function extractFirstSentence(text: string, maxLen: number): string {
  // Try to find a sentence boundary (CJK punctuation may not be followed by space)
  const sentenceEnd = text.search(/[.!?]\s|[。！？]/);
  if (sentenceEnd > 0 && sentenceEnd < maxLen) {
    return text.slice(0, sentenceEnd + 1);
  }
  if (text.length <= maxLen) return text;
  // Fall back to truncation at word boundary
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated) + "...";
}
