import { normalizeGovernanceText } from "./governance-rules.js";

export type ReasoningStrategyOutcome = "success" | "failure" | "mixed";
export type ReasoningStrategyKind = "validated" | "preventive" | "contrastive";

export interface ReasoningStrategyFields {
  reasoning_strategy: true;
  strategy_kind: ReasoningStrategyKind;
  outcome: ReasoningStrategyOutcome;
  strategy_title: string;
  strategy_summary: string;
  strategy_steps: string[];
  strategy_description?: string;
  failure_mode?: string;
  prevention?: string;
  success_signal?: string;
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function splitStepFragments(text: string): string[] {
  return text
    .replace(/\b(?:user|assistant)\s*:\s*/gi, "\n")
    .replace(/\s+(?=(?:Pitfall|Symptom|Cause|Fix|Prevention|Trigger|Action|Decision principle)\s*:)/gi, "\n")
    .replace(/\s*,?\s+then\s+/gi, "\n")
    .replace(/\.\s+/g, ".\n")
    .split(/\r?\n|[。！？!?]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeReasoningStrategySteps(steps: string[] | string): string[] {
  const raw = Array.isArray(steps)
    ? steps.flatMap(splitStepFragments)
    : splitStepFragments(steps);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const cleaned = item
      .replace(/^[\s\-*\d.)]+/, "")
      .replace(/[.。]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const key = normalizeGovernanceText(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(cleaned);
  }
  return normalized.slice(0, 6);
}

export function buildReasoningStrategyFields(params: {
  kind: ReasoningStrategyKind;
  outcome: ReasoningStrategyOutcome;
  title: string;
  steps: string[] | string;
  description?: string;
  failureMode?: string;
  prevention?: string;
  successSignal?: string;
}): ReasoningStrategyFields {
  const steps = normalizeReasoningStrategySteps(params.steps);
  const title = clip(params.title || steps[0] || "Reusable reasoning strategy", 220);
  const summary = clip(title, 220);
  return {
    reasoning_strategy: true,
    strategy_kind: params.kind,
    outcome: params.outcome,
    strategy_title: title,
    strategy_summary: summary,
    strategy_steps: steps,
    ...(params.description ? { strategy_description: clip(params.description, 500) } : {}),
    ...(params.failureMode ? { failure_mode: clip(params.failureMode, 500) } : {}),
    ...(params.prevention ? { prevention: clip(params.prevention, 500) } : {}),
    ...(params.successSignal ? { success_signal: clip(params.successSignal, 300) } : {}),
  };
}

export function formatStrategyStepsMarkdown(steps: string[]): string {
  return steps.map((step) => `- ${step}`).join("\n");
}

export function detectLessonReasoningStrategy(text: string): ReasoningStrategyFields | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const pitfallLike =
    /(?:^|\b)pitfall\s*:/i.test(trimmed) ||
    /(?:symptom|cause|fix|prevention)\s*:/i.test(trimmed) ||
    /(?:教训|坑|症状|原因|修复|预防)[:：]/i.test(trimmed);
  if (pitfallLike) {
    return buildReasoningStrategyFields({
      kind: "preventive",
      outcome: "failure",
      title: clip(trimmed, 220),
      steps: trimmed,
      description: trimmed,
      failureMode: trimmed,
      prevention: extractLabeledSection(trimmed, ["Prevention", "预防"]),
    });
  }

  const principleLike =
    /decision principle\s*\(/i.test(trimmed) ||
    /(?:trigger|action)\s*:/i.test(trimmed) ||
    /(?:原则|触发|动作|行动)[:：]/i.test(trimmed);
  if (principleLike) {
    return buildReasoningStrategyFields({
      kind: "validated",
      outcome: "success",
      title: clip(trimmed, 220),
      steps: trimmed,
      description: trimmed,
      successSignal: trimmed,
    });
  }

  return null;
}

function extractLabeledSection(text: string, labels: string[]): string | undefined {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stopPattern = [
    "Pitfall", "Symptom", "Cause", "Fix", "Prevention",
    "Trigger", "Action", "Decision principle",
    "教训", "坑", "症状", "原因", "修复", "预防", "触发", "动作", "行动", "原则",
  ].join("|");
  const re = new RegExp(`(?:${labelPattern})\\s*[:：]\\s*([\\s\\S]*?)(?=\\s+(?:${stopPattern})\\s*[:：]|$)`, "i");
  const match = re.exec(text);
  const value = match?.[1]?.trim();
  return value ? clip(value, 500) : undefined;
}
