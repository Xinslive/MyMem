export interface ReflectionSlices {
  invariants: string[];
  derived: string[];
}

export interface ReflectionMappedMemory {
  text: string;
  category: "preferences" | "cases" | "events";
  heading: string;
}

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";

export interface ReflectionMappedMemoryItem extends ReflectionMappedMemory {
  mappedKind: ReflectionMappedKind;
  ordinal: number;
  groupSize: number;
}

export interface ReflectionSliceItem {
  text: string;
  itemKind: "invariant" | "derived";
  section: "Invariants" | "Derived";
  ordinal: number;
  groupSize: number;
}

export interface ReflectionGovernanceEntry {
  priority?: string;
  status?: string;
  area?: string;
  summary: string;
  details?: string;
  suggestedAction?: string;
}

function normalizeMarkdownHeadingLabel(label: string): string {
  return label
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseMarkdownHeading(line: string): { level: number; label: string } | null {
  const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return {
    level: match[1].length,
    label: normalizeMarkdownHeadingLabel(match[2]),
  };
}

function extractSectionMarkdownForHeadings(markdown: string, headings: string[]): string {
  const lines = markdown.split(/\r?\n/);
  const headingNeedles = new Set(headings.map(normalizeMarkdownHeadingLabel));
  let inSection = false;
  let sectionLevel = 2;
  const collected: string[] = [];
  const sections: string[] = [];

  const flush = () => {
    const section = collected.join("\n").trim();
    if (section) sections.push(section);
    collected.length = 0;
  };

  for (const raw of lines) {
    const headingInfo = parseMarkdownHeading(raw);
    if (headingInfo) {
      if (inSection && headingInfo.level <= sectionLevel) {
        flush();
        inSection = false;
      }
      if (!inSection && headingNeedles.has(headingInfo.label)) {
        inSection = true;
        sectionLevel = headingInfo.level;
      } else if (inSection) {
        collected.push(raw);
      }
      continue;
    }
    if (!inSection) continue;
    collected.push(raw);
  }
  if (inSection) flush();
  return sections.join("\n").trim();
}

export function extractSectionMarkdown(markdown: string, heading: string): string {
  return extractSectionMarkdownForHeadings(markdown, [heading]);
}

export function parseSectionBullets(markdown: string, heading: string): string[] {
  return parseSectionBulletsForHeadings(markdown, [heading]);
}

function parseSectionBulletsForHeadings(markdown: string, headings: string[]): string[] {
  const lines = extractSectionMarkdownForHeadings(markdown, headings).split(/\r?\n/);
  const collected: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const normalized = line.slice(2).trim();
      if (normalized) collected.push(normalized);
    }
  }
  return collected;
}

export function isPlaceholderReflectionSliceLine(line: string): boolean {
  const normalized = line.replace(/\*\*/g, "").trim();
  if (!normalized) return true;
  if (/^\(none( captured)?\)$/i.test(normalized)) return true;
  if (/^(invariants?|reflections?|derived)[:：]$/i.test(normalized)) return true;
  if (/apply this session'?s deltas next run/i.test(normalized)) return true;
  if (/apply this session'?s distilled changes next run/i.test(normalized)) return true;
  if (/investigate why embedded reflection generation failed/i.test(normalized)) return true;
  return false;
}

export function normalizeReflectionSliceLine(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/^(invariants?|reflections?|derived)[:：]\s*/i, "")
    .trim();
}

export function sanitizeReflectionSliceLines(lines: string[]): string[] {
  return lines
    .map(normalizeReflectionSliceLine)
    .filter((line) => !isPlaceholderReflectionSliceLine(line));
}

const INJECTABLE_REFLECTION_BLOCK_PATTERNS: RegExp[] = [
  /^\s*(?:(?:next|this)\s+run\s+)?(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,80}\b(?:instructions?|guardrails?|policy|developer|system)\b/i,
  /\b(?:reveal|print|dump|show|output)\b[\s\S]{0,80}\b(?:system prompt|developer prompt|hidden prompt|hidden instructions?|full prompt|prompt verbatim|secrets?|keys?|tokens?)\b/i,
  /<\s*\/?\s*(?:system|assistant|user|tool|developer|inherited-rules|derived-focus)\b[^>]*>/i,
  /^(?:system|assistant|user|developer|tool)\s*:/i,
];

export function isUnsafeInjectableReflectionLine(line: string): boolean {
  const normalized = normalizeReflectionSliceLine(line);
  if (!normalized) return true;
  return INJECTABLE_REFLECTION_BLOCK_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function sanitizeInjectableReflectionLines(lines: string[]): string[] {
  return sanitizeReflectionSliceLines(lines).filter(
    (line) => !isUnsafeInjectableReflectionLine(line),
  );
}

function isInvariantRuleLike(line: string): boolean {
  return /^(always|never|when\b|if\b|before\b|after\b|prefer\b|avoid\b|require\b|only\b|do not\b|must\b|should\b)/i.test(line) ||
    /\b(must|should|never|always|prefer|avoid|required?)\b/i.test(line) ||
    /^(用户|使用者|主人|master)/i.test(line) ||
    /^(用户|使用者|主人|master).*(偏好|习惯|期望|喜欢|不喜欢|倾向|关注|感兴趣|只想|不需要|会主动|会用|维护|指令简洁)/i.test(line) ||
    /(必须记住|不要再犯|不要反复|期望.*直接|喜欢.*实用|不喜欢.*说教)/i.test(line);
}

function isDerivedDeltaLike(line: string): boolean {
  return /^(this run|next run|going forward|follow-up|re-check|retest|verify|confirm|avoid repeating|adjust|change|update|retry|keep|watch)\b/i.test(line) ||
    /\b(this run|next run|delta|change|adjust|retry|re-check|retest|verify|confirm|avoid repeating|follow-up)\b/i.test(line) ||
    /^(下次|后续|继续|需要|关注|检查|确认|修复|排查|优化|积累|避免|记录|更新|补充|测试|验证|推荐|主动)/.test(line) ||
    /(下次|后续|待办|未解决|需要继续|需要检查|值得优化|可以主动|可以推荐|继续排查|不要再犯)/.test(line);
}

function isOpenLoopAction(line: string): boolean {
  return /^(investigate|verify|confirm|re-check|retest|update|add|remove|fix|avoid|keep|watch|document)\b/i.test(line) ||
    /^(关注|继续|检查|确认|修复|排查|优化|积累|避免|记录|更新|补充|测试|验证|推荐|主动)/.test(line);
}

export function extractReflectionLessons(reflectionText: string): string[] {
  return sanitizeReflectionSliceLines(parseSectionBulletsForHeadings(reflectionText, [
    "Lessons & pitfalls (symptom / cause / fix / prevention)",
    "核心教训",
    "问题与修复",
    "问题和修复",
    "错误与修复",
  ]));
}

export function extractReflectionLearningGovernanceCandidates(reflectionText: string): ReflectionGovernanceEntry[] {
  const section = extractSectionMarkdown(reflectionText, "Memory governance candidates");
  if (!section) return [];

  const entryBlocks = section
    .split(/(?=^###\s+Entry\b)/gim)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = entryBlocks
    .map(parseReflectionGovernanceEntry)
    .filter((entry): entry is ReflectionGovernanceEntry => entry !== null);

  if (parsed.length > 0) return parsed;

  const fallbackBullets = sanitizeReflectionSliceLines(
    parseSectionBullets(reflectionText, "Memory governance candidates")
  );
  if (fallbackBullets.length === 0) return [];

  return [{
    priority: "medium",
    status: "pending",
    area: "config",
    summary: "Reflection memory governance candidates",
    details: fallbackBullets.map((line) => `- ${line}`).join("\n"),
    suggestedAction: "Review the governance candidates and preserve durable rules as MyMem memories or project rules when stable.",
  }];
}

function parseReflectionGovernanceEntry(block: string): ReflectionGovernanceEntry | null {
  const body = block.replace(/^###\s+Entry\b[^\n]*\n?/i, "").trim();
  if (!body) return null;

  const readField = (label: string): string | undefined => {
    const match = body.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`, "im"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };

  const readSection = (label: string): string | undefined => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`^###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|$)`, "im"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };

  const summary = readSection("Summary");
  if (!summary) return null;

  return {
    priority: readField("Priority"),
    status: readField("Status"),
    area: readField("Area"),
    summary,
    details: readSection("Details"),
    suggestedAction: readSection("Suggested Action"),
  };
}

export function extractReflectionMappedMemories(reflectionText: string): ReflectionMappedMemory[] {
  return extractReflectionMappedMemoryItems(reflectionText).map(({ text, category, heading }) => ({ text, category, heading }));
}

function extractReflectionMappedMemoryItemsWithSanitizer(
  reflectionText: string,
  sanitizeLines: (lines: string[]) => string[],
): ReflectionMappedMemoryItem[] {
  const mappedSections: Array<{
    heading: string;
    aliases?: string[];
    category: "preferences" | "cases" | "events";
    mappedKind: ReflectionMappedKind;
  }> = [
    {
      heading: "User model deltas (about the human)",
      aliases: ["用户偏好", "用户偏好（确认）", "用户偏好(确认)", "用户习惯", "用户画像"],
      category: "preferences",
      mappedKind: "user-model",
    },
    {
      heading: "Agent model deltas (about the assistant/system)",
      aliases: ["潜在改进", "改进方向", "助手改进", "系统改进"],
      category: "preferences",
      mappedKind: "agent-model",
    },
    {
      heading: "Lessons & pitfalls (symptom / cause / fix / prevention)",
      aliases: ["核心教训", "问题与修复", "问题和修复", "错误与修复"],
      category: "cases",
      mappedKind: "lesson",
    },
    {
      heading: "Decisions (durable)",
      aliases: ["关键决策", "决策", "持久决策"],
      category: "events",
      mappedKind: "decision",
    },
  ];

  return mappedSections.flatMap(({ heading, aliases = [], category, mappedKind }) => {
    const lines = sanitizeLines(parseSectionBulletsForHeadings(reflectionText, [heading, ...aliases]));
    const groupSize = lines.length;
    return lines.map((text, ordinal) => ({ text, category, heading, mappedKind, ordinal, groupSize }));
  });
}

export function extractReflectionMappedMemoryItems(reflectionText: string): ReflectionMappedMemoryItem[] {
  return extractReflectionMappedMemoryItemsWithSanitizer(reflectionText, sanitizeReflectionSliceLines);
}

export function extractInjectableReflectionMappedMemoryItems(reflectionText: string): ReflectionMappedMemoryItem[] {
  return extractReflectionMappedMemoryItemsWithSanitizer(reflectionText, sanitizeInjectableReflectionLines);
}

export function extractInjectableReflectionMappedMemories(reflectionText: string): ReflectionMappedMemory[] {
  return extractInjectableReflectionMappedMemoryItems(reflectionText).map(({ text, category, heading }) => ({ text, category, heading }));
}

function extractReflectionSlicesWithSanitizer(
  reflectionText: string,
  sanitizeLines: (lines: string[]) => string[],
): ReflectionSlices {
  const invariantSection = parseSectionBulletsForHeadings(reflectionText, [
    "Invariants",
    "用户偏好",
    "用户偏好（确认）",
    "用户偏好(确认)",
    "新增不变式",
    "新增/更新不变式",
    "核心发现",
  ]);
  const derivedSection = parseSectionBulletsForHeadings(reflectionText, [
    "Derived",
    "待办",
    "遗留待办",
    "潜在改进",
  ]);
  const mergedSection = parseSectionBullets(reflectionText, "Invariants & Reflections");

  const invariantsPrimary = sanitizeLines(invariantSection).filter(isInvariantRuleLike);
  const derivedPrimary = sanitizeLines(derivedSection).filter(isDerivedDeltaLike);

  const invariantLinesLegacy = sanitizeLines(
    mergedSection.filter((line) => /invariant|stable|policy|rule/i.test(line))
  ).filter(isInvariantRuleLike);
  const reflectionLinesLegacy = sanitizeLines(
    mergedSection.filter((line) => /reflect|inherit|derive|change|apply/i.test(line))
  ).filter(isDerivedDeltaLike);
  const openLoopLines = sanitizeLines(parseSectionBullets(reflectionText, "Open loops / next actions"))
    .filter(isOpenLoopAction)
    .filter(isDerivedDeltaLike);
  const durableDecisionLines = sanitizeLines(parseSectionBullets(reflectionText, "Decisions (durable)"))
    .filter(isInvariantRuleLike);

  const invariants = invariantsPrimary.length > 0
    ? invariantsPrimary
    : (invariantLinesLegacy.length > 0 ? invariantLinesLegacy : durableDecisionLines);
  const derived = derivedPrimary.length > 0
    ? derivedPrimary
    : [...reflectionLinesLegacy, ...openLoopLines];

  return {
    invariants: invariants.slice(0, 8),
    derived: derived.slice(0, 10),
  };
}

export function extractReflectionSlices(reflectionText: string): ReflectionSlices {
  return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeReflectionSliceLines);
}

export function extractInjectableReflectionSlices(reflectionText: string): ReflectionSlices {
  return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeInjectableReflectionLines);
}

function buildReflectionSliceItemsFromSlices(slices: ReflectionSlices): ReflectionSliceItem[] {
  const invariantGroupSize = slices.invariants.length;
  const derivedGroupSize = slices.derived.length;

  const invariantItems = slices.invariants.map((text, ordinal) => ({
    text,
    itemKind: "invariant" as const,
    section: "Invariants" as const,
    ordinal,
    groupSize: invariantGroupSize,
  }));
  const derivedItems = slices.derived.map((text, ordinal) => ({
    text,
    itemKind: "derived" as const,
    section: "Derived" as const,
    ordinal,
    groupSize: derivedGroupSize,
  }));

  return [...invariantItems, ...derivedItems];
}

export function extractReflectionSliceItems(reflectionText: string): ReflectionSliceItem[] {
  return buildReflectionSliceItemsFromSlices(extractReflectionSlices(reflectionText));
}

export function extractInjectableReflectionSliceItems(reflectionText: string): ReflectionSliceItem[] {
  return buildReflectionSliceItemsFromSlices(extractInjectableReflectionSlices(reflectionText));
}
