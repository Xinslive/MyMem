type GovernanceMemoryCategory = "preferences" | "patterns";
type GovernanceStoreCategory = "preference" | "other";
type GovernancePolarity = "prefer" | "avoid" | "neutral";

export interface GovernanceRule {
  text: string;
  normalizedText: string;
  canonicalId: string;
  topic: string;
  memoryCategory: GovernanceMemoryCategory;
  storeCategory: GovernanceStoreCategory;
  polarity: GovernancePolarity;
  confidence: number;
}

interface KnownGovernanceRule {
  canonicalId: string;
  topic: string;
  text: string;
  memoryCategory: GovernanceMemoryCategory;
  storeCategory: GovernanceStoreCategory;
  polarity: GovernancePolarity;
  confidence: number;
  patterns: RegExp[];
}

const KNOWN_GOVERNANCE_RULES: KnownGovernanceRule[] = [
  {
    canonicalId: "workflow:single-agent",
    topic: "workflow:single-agent",
    text: "Do not use multiple agents unless the user explicitly asks for delegation.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "avoid",
    confidence: 0.96,
    patterns: [
      /(?:不用|不要|别|避免).{0,8}(?:多\s*agent|多个\s*agent|multi[-\s]?agent|multiple agents|sub[-\s]?agents?)/i,
      /(?:don't|do not|avoid).{0,18}(?:multi[-\s]?agent|multiple agents|sub[-\s]?agents?)/i,
    ],
  },
  {
    canonicalId: "workflow:single-agent-opposite",
    topic: "workflow:single-agent",
    text: "Use multiple agents by default.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "prefer",
    confidence: 0.86,
    patterns: [
      /(?:use|prefer|need).{0,18}(?:multi[-\s]?agent|multiple agents|sub[-\s]?agents?)/i,
      /(?:使用|优先|需要).{0,10}(?:多\s*agent|多个\s*agent)/i,
    ],
  },
  {
    canonicalId: "workflow:avoid-generic-advice",
    topic: "workflow:avoid-generic-advice",
    text: "Avoid generic or boilerplate advice; stay specific to the user's constraints.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "avoid",
    confidence: 0.94,
    patterns: [
      /(?:不要|别|避免).{0,8}(?:泛泛建议|泛泛而谈|空泛建议|套话)/i,
      /(?:don't|do not|avoid).{0,18}(?:generic advice|boilerplate advice|vague advice)/i,
    ],
  },
  {
    canonicalId: "workflow:avoid-generic-advice-opposite",
    topic: "workflow:avoid-generic-advice",
    text: "Generic high-level advice is acceptable.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "prefer",
    confidence: 0.82,
    patterns: [
      /(?:generic|high-level).{0,12}(?:advice).{0,12}(?:is fine|is okay|works)/i,
      /(?:泛泛建议|高层建议).{0,8}(?:也可以|可以接受|没问题)/i,
    ],
  },
  {
    canonicalId: "workflow:constraints-first",
    topic: "workflow:constraints-first",
    text: "Ground the response in the user's concrete constraints before proposing a solution.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "prefer",
    confidence: 0.92,
    patterns: [
      /(?:先|优先).{0,8}(?:结合|看|按).{0,8}(?:约束|限制|前提)/i,
      /(?:constraints?|requirements?).{0,18}(?:first|before)/i,
      /(?:ground|anchor).{0,18}(?:constraints?|requirements?)/i,
    ],
  },
  {
    canonicalId: "style:concise-direct",
    topic: "style:concise-direct",
    text: "Keep responses concise and direct.",
    memoryCategory: "preferences",
    storeCategory: "preference",
    polarity: "prefer",
    confidence: 0.9,
    patterns: [
      /(?:简洁一点|简短一点|直接一点|简明|简洁回复|简洁回答)/i,
      /(?:concise|brief|short|direct|factual).{0,16}(?:response|reply|answer)?/i,
    ],
  },
  {
    canonicalId: "workflow:avoid-reconfirm",
    topic: "workflow:avoid-reconfirm",
    text: "Avoid repeated confirmation loops; make a reasonable assumption and proceed unless the risk is high.",
    memoryCategory: "patterns",
    storeCategory: "other",
    polarity: "avoid",
    confidence: 0.95,
    patterns: [
      /(?:别|不要|避免).{0,10}(?:确认来确认去|反复确认|一直确认)/i,
      /(?:don't|do not|avoid).{0,22}(?:repeated confirmations?|confirmation loops?|asking to confirm repeatedly)/i,
    ],
  },
];

const STRONG_NEGATIVE_PATTERNS = [
  /(?:不是我想要的|不是我要的|方向错了|这个方向不对|跑偏了)/i,
  /(?:not what i want|wrong direction|this isn'?t what i asked|off track)/i,
];

const TASK_CLOSURE_PATTERNS = [
  /\b(?:fixed|resolved|working|passed|done|implemented|completed|shipped)\b/i,
  /(?:修好了|解决了|完成了|搞定了|通过了|已经好了|已完成|已解决)/,
];

const REUSABLE_STEP_PATTERNS = [
  /\b(?:run|check|verify|inspect|patch|update|compare|reproduce|test|store|compile|distill|prune|compact|archive|trace|review)\b/i,
  /(?:运行|检查|验证|排查|修复|更新|比较|复现|测试|记录|归档|蒸馏|裁剪|压缩)/,
];

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function normalizeGovernanceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\d.)\s-]+/, "")
    .replace(/\b(?:user|assistant)\s*:\s*/g, "")
    .replace(/[“”"'`]/g, "")
    .replace(/[。.!?;；:：]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeRules(rules: GovernanceRule[]): GovernanceRule[] {
  const seen = new Set<string>();
  const out: GovernanceRule[] = [];
  for (const rule of rules) {
    if (!rule.text || seen.has(rule.canonicalId)) continue;
    seen.add(rule.canonicalId);
    out.push(rule);
  }
  return out;
}

function buildFallbackRule(
  text: string,
  categoryHint?: GovernanceMemoryCategory,
): GovernanceRule | null {
  const cleaned = clip(
    text
      .replace(/^(?:user|assistant)\s*:\s*/i, "")
      .replace(/^[\d.)\s-]+/, "")
      .trim(),
    220,
  );
  const normalized = normalizeGovernanceText(cleaned);
  if (normalized.length < 8) return null;

  const inferredCategory = categoryHint ?? (
    /(concise|brief|short|direct|factual|tone|style|prefer|希望|喜欢|简洁|直接|语气|回复)/i.test(cleaned)
      ? "preferences"
      : "patterns"
  );
  const polarity: GovernancePolarity =
    /^(?:do not|don't|avoid|不要|别|避免)\b/i.test(cleaned)
      ? "avoid"
      : /(?:prefer|keep|use|希望|请|先|优先|保持|简洁|直接)/i.test(cleaned)
        ? "prefer"
        : "neutral";

  return {
    text: cleaned,
    normalizedText: normalized,
    canonicalId: `rule:${normalized.slice(0, 120)}`,
    topic: `rule:${normalized.slice(0, 120)}`,
    memoryCategory: inferredCategory,
    storeCategory: inferredCategory === "preferences" ? "preference" : "other",
    polarity,
    confidence: 0.62,
  };
}

export function extractGovernanceRulesFromText(
  text: string,
  categoryHint?: GovernanceMemoryCategory,
): GovernanceRule[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const rules: GovernanceRule[] = [];
  for (const known of KNOWN_GOVERNANCE_RULES) {
    if (!known.patterns.some((pattern) => pattern.test(trimmed))) continue;
    rules.push({
      text: known.text,
      normalizedText: normalizeGovernanceText(known.text),
      canonicalId: known.canonicalId,
      topic: known.topic,
      memoryCategory: known.memoryCategory,
      storeCategory: known.storeCategory,
      polarity: known.polarity,
      confidence: known.confidence,
    });
  }

  if (rules.length > 0) return dedupeRules(rules);

  const sentences = trimmed
    .split(/\r?\n|[。！？!?;；]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const fallback = buildFallbackRule(sentence, categoryHint);
    if (fallback) rules.push(fallback);
  }

  return dedupeRules(rules);
}

export function inferGovernanceRuleFromMemory(
  text: string,
  categoryHint?: string,
): GovernanceRule | null {
  const inferredHint = categoryHint === "preferences" || categoryHint === "patterns"
    ? categoryHint
    : undefined;
  const rules = extractGovernanceRulesFromText(text, inferredHint);
  return rules[0] ?? buildFallbackRule(text, inferredHint);
}

export function extractActiveConstraintHints(text: string, maxItems = 2): string[] {
  return extractGovernanceRulesFromText(text)
    .slice(0, Math.max(0, maxItems))
    .map((rule) => rule.text);
}

export function rulesConflict(left: GovernanceRule | null, right: GovernanceRule | null): boolean {
  if (!left || !right) return false;
  if (left.topic !== right.topic) return false;
  if (left.polarity !== "neutral" && right.polarity !== "neutral" && left.polarity !== right.polarity) {
    return true;
  }
  return left.normalizedText !== right.normalizedText &&
    !left.canonicalId.startsWith("rule:") &&
    !right.canonicalId.startsWith("rule:");
}

export function containsStrongNegativeGovernanceFeedback(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && STRONG_NEGATIVE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function hasTaskClosureSignal(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && TASK_CLOSURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function extractReusableSteps(text: string, maxItems = 3): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();
  const steps: string[] = [];
  const lines = trimmed
    .split(/\r?\n|[。！？!?]/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    const line = rawLine.replace(/^(?:user|assistant)\s*:\s*/i, "").trim();
    if (line.length < 12 || line.length > 180) continue;
    if (!REUSABLE_STEP_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const normalized = normalizeGovernanceText(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    steps.push(line);
    if (steps.length >= maxItems) break;
  }

  return steps;
}
