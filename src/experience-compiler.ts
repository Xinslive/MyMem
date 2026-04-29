import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Embedder } from "./embedder.js";
import type { Logger } from "./logger.js";
import type { ExperienceCompilerConfig } from "./plugin-types.js";
import type { MemoryEntry } from "./store.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import {
  containsStrongNegativeGovernanceFeedback,
  extractReusableSteps,
  hasTaskClosureSignal,
  normalizeGovernanceText,
} from "./governance-rules.js";

type CompilerStore = {
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry>;
  update(id: string, updates: { metadata?: string }, scopeFilter?: string[]): Promise<MemoryEntry | null>;
};

export interface ExperienceCompilerDeps {
  store: CompilerStore;
  embedder: Pick<Embedder, "embedPassage">;
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
};

function normalizeConfig(config?: ExperienceCompilerConfig): Required<ExperienceCompilerConfig> {
  return {
    enabled: config?.enabled !== false,
    gatewayBackfill: config?.gatewayBackfill !== false,
    cooldownHours: Math.max(1, Math.floor(config?.cooldownHours ?? DEFAULT_EXPERIENCE_COMPILER_CONFIG.cooldownHours)),
    maxStrategiesPerRun: Math.max(1, Math.floor(config?.maxStrategiesPerRun ?? DEFAULT_EXPERIENCE_COMPILER_CONFIG.maxStrategiesPerRun)),
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

function collectStrategies(
  rows: MemoryEntry[],
  maxStrategiesPerRun: number,
  conversationBySession: Map<string, string>,
): Array<{
  sessionMarker: string;
  scope: string;
  summary: string;
  overview: string;
  content: string;
  caseIds: string[];
  canonicalId: string;
  confidence: number;
}> {
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
    if (!caseRows.length && !hasTaskClosureSignal(closureText)) continue;

    const steps = extractReusableSteps(closureText, 4);
    if (steps.length === 0) continue;

    const summary = buildStrategySummary(steps);
    compiled.push({
      sessionMarker,
      scope: caseRows[0]?.scope ?? sessionRows[0]?.scope ?? "global",
      summary,
      overview: steps.map((step) => `- ${step}`).join("\n"),
      content: [
        "Reusable strategy compiled from recent successful work:",
        ...steps.map((step, index) => `${index + 1}. ${step}`),
      ].join("\n"),
      caseIds: caseRows.map((entry) => entry.id).slice(0, 8),
      canonicalId: `strategy:${normalizeGovernanceText(steps.join(" ")).slice(0, 120)}`,
      confidence: hasTaskClosureSignal(closureText) ? 0.8 : 0.72,
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

  const strategies = collectStrategies(
    params?.sessionKey
      ? rows.filter((entry) => readSessionMarker(entry) === params.sessionKey)
      : rows,
    cfg.maxStrategiesPerRun,
    conversationBySession,
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
      const next = buildSmartMetadata(existing, {
        compiled_strategy: true,
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

    const now = Date.now();
    const vector = await deps.embedder.embedPassage(strategy.summary);
    await deps.store.store({
      text: strategy.summary,
      vector,
      importance: 0.8,
      category: "other",
      scope: strategy.scope,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          {
            text: strategy.summary,
            category: "other",
            importance: 0.8,
            timestamp: now,
          },
          {
            l0_abstract: strategy.summary,
            l1_overview: strategy.overview,
            l2_content: strategy.content,
            memory_category: "patterns",
            confidence: strategy.confidence,
            source: "auto-capture",
            source_reason: "experience_compiler",
            source_session: strategy.sessionMarker,
            compiled_strategy: true,
            compiled_from_case_ids: strategy.caseIds,
            canonical_id: strategy.canonicalId,
            state: "confirmed",
            memory_layer: "working",
            last_confirmed_use_at: now,
          },
        ),
      ),
    });
    result.created++;
  }

  deps.logger?.info?.(
    `memory-experience-compiler: scanned=${result.scanned} sessions=${result.sessionsConsidered} ` +
      `created=${result.created} updated=${result.updated} skipped=${result.skipped}`,
  );

  return result;
}
