import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Logger } from "./logger.js";
import type { ExperienceCompilerConfig } from "./plugin-types.js";
import type { Embedder } from "./embedder.js";
import type { LlmClient } from "./llm-client.js";
import type { MemoryEntry } from "./store.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import {
  containsStrongNegativeGovernanceFeedback,
  extractReusableSteps,
  hasTaskClosureSignal,
  normalizeGovernanceText,
} from "./governance-rules.js";
import {
  buildReasoningStrategyFields,
  formatStrategyStepsMarkdown,
  type ReasoningStrategyKind,
  type ReasoningStrategyOutcome,
} from "./reasoning-strategy.js";
import { buildRefineStrategyStepsPrompt } from "./extraction-prompts.js";

type CompilerStore = {
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  update(id: string, updates: { metadata?: string }, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry>;
};

export interface ExperienceCompilerDeps {
  store: CompilerStore;
  embedder?: Pick<Embedder, "embedPassage">;
  llm?: LlmClient;
  logger?: Pick<Logger, "info" | "warn" | "debug">;
}

export interface ExperienceCompilerResult {
  scanned: number;
  sessionsConsidered: number;
  created: number;
  updated: number;
  skipped: number;
}

export const DEFAULT_EXPERIENCE_COMPILER_CONFIG: Required<ExperienceCompilerConfig> = {
  enabled: true,
  gatewayBackfill: true,
  cooldownHours: 4,
  maxStrategiesPerRun: 3,
  useLlm: true,
};

function normalizeConfig(config?: ExperienceCompilerConfig): Required<ExperienceCompilerConfig> {
  return {
    enabled: config?.enabled !== false,
    gatewayBackfill: config?.gatewayBackfill !== false,
    cooldownHours: Math.max(1, Math.floor(config?.cooldownHours ?? DEFAULT_EXPERIENCE_COMPILER_CONFIG.cooldownHours)),
    maxStrategiesPerRun: Math.max(1, Math.floor(config?.maxStrategiesPerRun ?? DEFAULT_EXPERIENCE_COMPILER_CONFIG.maxStrategiesPerRun)),
    useLlm: config?.useLlm !== false,
  };
}

function readSessionMarker(entry: MemoryEntry): string {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const sourceSession = typeof meta.source_session === "string" ? meta.source_session.trim() : "";
  if (sourceSession) return sourceSession;
  const sessionKey = typeof meta.sessionKey === "string" ? meta.sessionKey.trim() : "";
  if (sessionKey) return sessionKey;
  const sessionId = typeof meta.sessionId === "string" ? meta.sessionId.trim() : "";
  if (sessionId) return sessionId;
  return `${entry.scope}:${new Date(entry.timestamp).toISOString().slice(0, 10)}`;
}

function buildStrategySummary(steps: string[]): string {
  const sentence = steps.slice(0, 3).join(" Then ");
  const summary = `Reusable strategy: ${sentence}`;
  return summary.length <= 220 ? summary : `${summary.slice(0, 219).trimEnd()}…`;
}

function containsFailureSignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(?:\b(error|failed|failure|exception|traceback|regression|timeout|wrong|incorrect|flaky)\b|报错|失败|异常|回归|超时|不对|错误|没通过)/i.test(trimmed);
}

function containsRecoverySignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(?:\b(recovered|recovery|retried|reran|fixed after|resolved after|fallback worked|workaround)\b|恢复|重试后|重新运行后|绕过后|修复后)/i.test(trimmed);
}

function buildPreventiveSteps(steps: string[]): string[] {
  const prefixPattern = /^(?:avoid|prevent|before|verify|check|retest|confirm|do not|don't|不要|避免|先|验证|确认)\b/i;
  return steps.map((step) => {
    if (prefixPattern.test(step)) return step;
    return `Before repeating this failure mode, ${step.charAt(0).toLowerCase()}${step.slice(1)}`;
  });
}

async function refineStepsWithLlm(
  steps: string[],
  failureContext: string,
  llm: LlmClient | undefined,
  maxItems: number,
  logger?: Pick<Logger, "info" | "warn" | "debug">,
): Promise<string[]> {
  if (!llm || steps.length === 0) return steps;
  try {
    const prompt = buildRefineStrategyStepsPrompt(steps, failureContext);
    const result = await llm.completeJson<{ refined_steps?: string[] }>(prompt, "strategy-step-refinement");
    if (!result?.refined_steps || !Array.isArray(result.refined_steps) || result.refined_steps.length === 0) {
      logger?.debug?.("mymem: experience-compiler LLM refinement returned empty/invalid result, using original steps");
      return steps;
    }
    const refined = result.refined_steps
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length >= 8)
      .slice(0, maxItems);
    if (refined.length === 0) {
      logger?.debug?.("mymem: experience-compiler LLM refinement filtered all steps, using original steps");
      return steps;
    }
    logger?.debug?.(`mymem: experience-compiler LLM refinement: ${steps.length} -> ${refined.length} steps`);
    return refined;
  } catch (err) {
    logger?.warn?.(`mymem: experience-compiler LLM refinement failed: ${err instanceof Error ? err.message : String(err)}`);
    return steps;
  }
}

async function collectStrategies(
  rows: MemoryEntry[],
  maxStrategiesPerRun: number,
  conversationBySession: Map<string, string>,
  llm: LlmClient | undefined,
  logger?: Pick<Logger, "info" | "warn" | "debug">,
): Promise<Array<{
  sessionMarker: string;
  scope: string;
  summary: string;
  overview: string;
  content: string;
  caseIds: string[];
  canonicalId: string;
  confidence: number;
  outcome: ReasoningStrategyOutcome;
  strategyKind: ReasoningStrategyKind;
  strategyTitle: string;
  strategySteps: string[];
  strategyDescription: string;
  failureMode?: string;
  successSignal?: string;
}>> {
  const sessionGroups = new Map<string, MemoryEntry[]>();
  for (const entry of rows) {
    const marker = readSessionMarker(entry);
    const current = sessionGroups.get(marker) ?? [];
    current.push(entry);
    sessionGroups.set(marker, current);
  }

  const compiled: Array<{
    sessionMarker: string;
    scope: string;
    summary: string;
    overview: string;
    content: string;
    caseIds: string[];
    canonicalId: string;
    confidence: number;
    outcome: ReasoningStrategyOutcome;
    strategyKind: ReasoningStrategyKind;
    strategyTitle: string;
    strategySteps: string[];
    strategyDescription: string;
    failureMode?: string;
    successSignal?: string;
  }> = [];

  for (const [sessionMarker, sessionRows] of [...sessionGroups.entries()].sort((a, b) => {
    const left = Math.max(...a[1].map((row) => row.timestamp));
    const right = Math.max(...b[1].map((row) => row.timestamp));
    return right - left;
  })) {
    const conversation = conversationBySession.get(sessionMarker) ?? "";
    if (containsStrongNegativeGovernanceFeedback(conversation)) continue;

    const caseRows = sessionRows.filter((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      return meta.state !== "archived" && (meta.memory_category === "cases" || meta.memory_category === "events");
    });

    const joinedCaseText = caseRows
      .map((entry) => {
        const meta = parseSmartMetadata(entry.metadata, entry);
        return [meta.l0_abstract, meta.l1_overview, meta.l2_content].filter(Boolean).join("\n");
      })
      .join("\n");

    const closureText = [conversation, joinedCaseText].filter(Boolean).join("\n");
    const hasClosure = hasTaskClosureSignal(closureText);
    const hasFailure = containsFailureSignal(closureText);
    const hasRecovery = containsRecoverySignal(closureText);
    if (!caseRows.length && !hasClosure && !hasFailure) continue;

    const rawSteps = extractReusableSteps(closureText, 4);
    const refinedRawSteps = await refineStepsWithLlm(rawSteps, closureText, llm, 4, logger);
    const steps = hasFailure && !hasClosure ? buildPreventiveSteps(refinedRawSteps) : refinedRawSteps;
    if (steps.length === 0) continue;

    const outcome: ReasoningStrategyOutcome =
      hasFailure && hasClosure && hasRecovery ? "mixed" : hasClosure ? "success" : hasFailure ? "failure" : "success";
    const strategyKind: ReasoningStrategyKind =
      outcome === "mixed" ? "contrastive" : outcome === "failure" ? "preventive" : "validated";
    const strategyTitle = buildStrategySummary(steps);
    const strategyDescription = strategyKind === "preventive"
      ? "Preventive strategy compiled from a recent failure mode."
      : strategyKind === "contrastive"
        ? "Contrastive strategy compiled from a recent failure and recovery."
        : "Reusable strategy compiled from recent successful work.";
    compiled.push({
      sessionMarker,
      scope: caseRows[0]?.scope ?? sessionRows[0]?.scope ?? "global",
      summary: strategyTitle,
      overview: formatStrategyStepsMarkdown(steps),
      content: [
        `${strategyDescription}:`,
        ...steps.map((step, index) => `${index + 1}. ${step}`),
      ].join("\n"),
      caseIds: caseRows.map((entry) => entry.id).slice(0, 8),
      canonicalId: `strategy:${strategyKind}:${normalizeGovernanceText(steps.join(" ")).slice(0, 120)}`,
      confidence: outcome === "success" ? 0.8 : outcome === "mixed" ? 0.76 : 0.68,
      outcome,
      strategyKind,
      strategyTitle,
      strategySteps: steps,
      strategyDescription,
      failureMode: hasFailure ? closureText.slice(0, 220).trim() : undefined,
      successSignal: hasClosure ? closureText.slice(-220).trim() : undefined,
    });

    if (compiled.length >= maxStrategiesPerRun) break;
  }

  return compiled;
}

export async function shouldRunExperienceCompiler(
  stateFile: string,
  cooldownHours: number,
): Promise<boolean> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const state = JSON.parse(raw) as { lastRunAt?: number };
    if (typeof state.lastRunAt === "number") {
      return Date.now() - state.lastRunAt >= cooldownHours * 60 * 60 * 1000;
    }
  } catch {
    // Missing or malformed state means this is the first run.
  }
  return true;
}

export async function recordExperienceCompilerRun(stateFile: string): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}

export async function runExperienceCompiler(
  deps: ExperienceCompilerDeps,
  config?: ExperienceCompilerConfig,
  params?: {
    scopeFilter?: string[];
    sessionKey?: string;
    conversation?: string;
  },
): Promise<ExperienceCompilerResult> {
  const cfg = normalizeConfig(config);
  const result: ExperienceCompilerResult = {
    scanned: 0,
    sessionsConsidered: 0,
    created: 0,
    updated: 0,
    skipped: 0,
  };

  if (!cfg.enabled) return result;

  const rows = await deps.store.list(params?.scopeFilter, undefined, 320, 0);
  result.scanned = rows.length;

  const conversationBySession = new Map<string, string>();
  if (params?.sessionKey && params.conversation) {
    conversationBySession.set(params.sessionKey, params.conversation);
  }

  const strategies = await collectStrategies(
    params?.sessionKey
      ? rows.filter((entry) => readSessionMarker(entry) === params.sessionKey)
      : rows,
    cfg.maxStrategiesPerRun,
    conversationBySession,
    cfg.useLlm !== false ? deps.llm : undefined,
    deps.logger,
  );
  result.sessionsConsidered = strategies.length;

  const existingStrategies = rows.filter((entry) => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    return meta.state !== "archived" && meta.compiled_strategy === true && meta.memory_category === "patterns";
  });

  for (const strategy of strategies) {
    const existing = existingStrategies.find((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      return meta.canonical_id === strategy.canonicalId;
    });

    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      const strategyFields = buildReasoningStrategyFields({
        kind: strategy.strategyKind,
        outcome: strategy.outcome,
        title: strategy.strategyTitle,
        steps: strategy.strategySteps,
        description: strategy.strategyDescription,
        failureMode: strategy.failureMode,
        prevention: strategy.outcome !== "success" ? strategy.strategySteps.join(" ") : undefined,
        successSignal: strategy.successSignal,
      });
      const next = buildSmartMetadata(existing, {
        compiled_strategy: true,
        ...strategyFields,
        compiled_from_case_ids: Array.from(new Set([
          ...(Array.isArray(meta.compiled_from_case_ids) ? meta.compiled_from_case_ids : []),
          ...strategy.caseIds,
        ])).slice(0, 12),
        source_reason: "experience_compiler",
        confidence: Math.max(Number(meta.confidence ?? 0.7), strategy.confidence),
        last_confirmed_use_at: Date.now(),
      });
      await deps.store.update(existing.id, { metadata: stringifySmartMetadata(next) }, params?.scopeFilter);
      result.updated++;
      continue;
    }

    // Create new strategy entry
    if (deps.embedder) {
      const now = Date.now();
      const vector = await deps.embedder.embedPassage(strategy.content);
      const strategyFields = buildReasoningStrategyFields({
        kind: strategy.strategyKind,
        outcome: strategy.outcome,
        title: strategy.strategyTitle,
        steps: strategy.strategySteps,
        description: strategy.strategyDescription,
        failureMode: strategy.failureMode,
        prevention: strategy.outcome !== "success" ? strategy.strategySteps.join(" ") : undefined,
        successSignal: strategy.successSignal,
      });
      await deps.store.store({
        text: strategy.content,
        vector,
        category: "other",
        scope: strategy.scope,
        importance: strategy.confidence,
        metadata: stringifySmartMetadata(buildSmartMetadata(
          { text: strategy.content, category: "other", importance: strategy.confidence, timestamp: now } as MemoryEntry,
          {
            ...strategyFields,
            compiled_strategy: true,
            memory_category: "patterns",
            canonical_id: strategy.canonicalId,
            compiled_from_case_ids: strategy.caseIds,
            source_reason: "experience_compiler",
            evidence_count: 1,
            last_evidence_at: now,
            confidence: strategy.confidence,
            state: "confirmed",
            memory_layer: "working",
          },
        )),
      });
      result.created++;
    } else {
      result.skipped++;
    }
  }

  deps.logger?.info?.(
    `memory-experience-compiler: scanned=${result.scanned} sessions=${result.sessionsConsidered} ` +
      `created=${result.created} updated=${result.updated} skipped=${result.skipped}`,
  );

  return result;
}
