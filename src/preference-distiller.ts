import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Logger } from "./logger.js";
import type { PreferenceDistillerConfig } from "./plugin-types.js";
import type { Embedder } from "./embedder.js";
import type { MemoryEntry } from "./store.js";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import { inferGovernanceRuleFromMemory, rulesConflict, type GovernanceRule } from "./governance-rules.js";

type DistillStore = {
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  update(id: string, updates: { metadata?: string; text?: string; vector?: number[]; importance?: number; category?: MemoryEntry["category"] }, scopeFilter?: string[]): Promise<MemoryEntry | null>;
};

export interface PreferenceDistillerDeps {
  store: DistillStore;
  /** Kept for call-site compatibility; distillation is update-only and does not embed new records. */
  embedder?: Pick<Embedder, "embedPassage">;
  logger?: Pick<Logger, "info" | "warn" | "debug">;
}

export interface PreferenceDistillerResult {
  scanned: number;
  sessionsConsidered: number;
  candidates: number;
  created: number;
  updated: number;
  superseded: number;
  skipped: number;
}

export const DEFAULT_PREFERENCE_DISTILLER_CONFIG: Required<PreferenceDistillerConfig> = {
  enabled: true,
  gatewayBackfill: true,
  cooldownHours: 4,
  maxSessions: 12,
  minEvidenceCount: 2,
  minStabilityScore: 0.6,
  maxRulesPerRun: 5,
};

type Evidence = {
  id: string;
  sessionMarker: string;
  scope: string;
  rule: GovernanceRule;
  confidence: number;
  timestamp: number;
};

type AggregatedRule = {
  rule: GovernanceRule;
  evidenceIds: string[];
  evidenceCount: number;
  stabilityScore: number;
  confidence: number;
  latestTimestamp: number;
  latestScope: string;
  latestSessionMarker: string;
};

function normalizeConfig(config?: PreferenceDistillerConfig): Required<PreferenceDistillerConfig> {
  return {
    enabled: config?.enabled !== false,
    gatewayBackfill: config?.gatewayBackfill !== false,
    cooldownHours: Math.max(1, Math.floor(config?.cooldownHours ?? DEFAULT_PREFERENCE_DISTILLER_CONFIG.cooldownHours)),
    maxSessions: Math.max(1, Math.floor(config?.maxSessions ?? DEFAULT_PREFERENCE_DISTILLER_CONFIG.maxSessions)),
    minEvidenceCount: Math.max(1, Math.floor(config?.minEvidenceCount ?? DEFAULT_PREFERENCE_DISTILLER_CONFIG.minEvidenceCount)),
    minStabilityScore: typeof config?.minStabilityScore === "number"
      ? Math.max(0, Math.min(1, config.minStabilityScore))
      : DEFAULT_PREFERENCE_DISTILLER_CONFIG.minStabilityScore,
    maxRulesPerRun: Math.max(1, Math.floor(config?.maxRulesPerRun ?? DEFAULT_PREFERENCE_DISTILLER_CONFIG.maxRulesPerRun)),
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

function isDistillerInput(entry: MemoryEntry): boolean {
  const meta = parseSmartMetadata(entry.metadata, entry);
  if (meta.state === "archived") return false;
  if (meta.source === "session-summary") return false;
  if (meta.source_reason === "preference_distiller") return false;
  if (meta.compiled_strategy === true) return false;

  if (meta.type === "memory-reflection-mapped") {
    return meta.mappedKind === "user-model" ||
      meta.mappedKind === "agent-model" ||
      meta.mappedKind === "lesson" ||
      meta.mappedKind === "decision";
  }

  if (meta.source_reason === "self_correction" && (meta.memory_category === "preferences" || meta.memory_category === "patterns")) {
    return Number(meta.confidence ?? 0) >= 0.55;
  }

  return meta.memory_category === "preferences" || meta.memory_category === "patterns";
}

function entryToEvidence(entry: MemoryEntry): Evidence | null {
  if (!isDistillerInput(entry)) return null;

  const meta = parseSmartMetadata(entry.metadata, entry);
  const confidence = Math.max(0.55, Math.min(1, Number(meta.confidence ?? 0.7)));
  let categoryHint: "preferences" | "patterns" | undefined;

  if (meta.type === "memory-reflection-mapped") {
    if (meta.mappedKind === "user-model") categoryHint = "preferences";
    if (meta.mappedKind === "agent-model" || meta.mappedKind === "lesson" || meta.mappedKind === "decision") {
      categoryHint = "patterns";
    }
  } else if (meta.memory_category === "preferences" || meta.memory_category === "patterns") {
    categoryHint = meta.memory_category;
  }

  const seedText = meta.l0_abstract || entry.text;
  const rule = inferGovernanceRuleFromMemory(seedText, categoryHint);
  if (!rule) return null;

  return {
    id: entry.id,
    sessionMarker: readSessionMarker(entry),
    scope: entry.scope,
    rule,
    confidence,
    timestamp: entry.timestamp,
  };
}

function computeStability(evidenceCount: number, distinctSessions: number, avgConfidence: number): number {
  return Math.min(
    1,
    Math.max(0, Math.min(1, distinctSessions / Math.max(2, evidenceCount))) * 0.45 +
      Math.max(0, Math.min(1, avgConfidence)) * 0.55,
  );
}

function aggregateEvidence(
  rows: MemoryEntry[],
  maxSessions: number,
): { aggregates: AggregatedRule[]; sessionsConsidered: number } {
  const recentSessionMarkers: string[] = [];
  const sessionSeen = new Set<string>();

  for (const entry of rows) {
    const marker = readSessionMarker(entry);
    if (sessionSeen.has(marker)) continue;
    sessionSeen.add(marker);
    recentSessionMarkers.push(marker);
    if (recentSessionMarkers.length >= maxSessions) break;
  }

  const allowedSessions = new Set(recentSessionMarkers);
  const grouped = new Map<string, Evidence[]>();

  for (const entry of rows) {
    const evidence = entryToEvidence(entry);
    if (!evidence || !allowedSessions.has(evidence.sessionMarker)) continue;
    const groupKey = `${evidence.rule.memoryCategory}::${evidence.rule.canonicalId}`;
    const current = grouped.get(groupKey) ?? [];
    current.push(evidence);
    grouped.set(groupKey, current);
  }

  const aggregates = [...grouped.values()].map((items) => {
    const latest = [...items].sort((a, b) => b.timestamp - a.timestamp)[0];
    const avgConfidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
    const sessionCount = new Set(items.map((item) => item.sessionMarker)).size;
    return {
      rule: latest.rule,
      evidenceIds: items.map((item) => item.id).slice(-12),
      evidenceCount: items.length,
      stabilityScore: computeStability(items.length, sessionCount, avgConfidence),
      confidence: Math.max(latest.rule.confidence, avgConfidence),
      latestTimestamp: latest.timestamp,
      latestScope: latest.scope,
      latestSessionMarker: latest.sessionMarker,
    };
  });

  return { aggregates, sessionsConsidered: recentSessionMarkers.length };
}

function isActiveRule(entry: MemoryEntry): boolean {
  const meta = parseSmartMetadata(entry.metadata, entry);
  return meta.state !== "archived" && (meta.memory_category === "preferences" || meta.memory_category === "patterns");
}

export async function shouldRunPreferenceDistiller(
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

export async function recordPreferenceDistillerRun(stateFile: string): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}

export async function runPreferenceDistiller(
  deps: PreferenceDistillerDeps,
  config?: PreferenceDistillerConfig,
  scopeFilter?: string[],
): Promise<PreferenceDistillerResult> {
  const cfg = normalizeConfig(config);
  const result: PreferenceDistillerResult = {
    scanned: 0,
    sessionsConsidered: 0,
    candidates: 0,
    created: 0,
    updated: 0,
    superseded: 0,
    skipped: 0,
  };

  if (!cfg.enabled) return result;

  const rows = await deps.store.list(scopeFilter, undefined, 400, 0);
  result.scanned = rows.length;

  const activeRows = rows.filter(isActiveRule);
  const { aggregates, sessionsConsidered } = aggregateEvidence(rows, cfg.maxSessions);
  result.sessionsConsidered = sessionsConsidered;

  const candidates = aggregates
    .filter((aggregate) =>
      aggregate.evidenceCount >= cfg.minEvidenceCount &&
      aggregate.stabilityScore >= cfg.minStabilityScore,
    )
    .sort((a, b) => {
      if (b.stabilityScore !== a.stabilityScore) return b.stabilityScore - a.stabilityScore;
      if (b.evidenceCount !== a.evidenceCount) return b.evidenceCount - a.evidenceCount;
      return b.latestTimestamp - a.latestTimestamp;
    })
    .slice(0, cfg.maxRulesPerRun);

  result.candidates = candidates.length;

  for (const candidate of candidates) {
    const sameTopic = activeRows.filter((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      if (meta.memory_category !== candidate.rule.memoryCategory) return false;
      if (typeof meta.canonical_id === "string" && meta.canonical_id.trim() && meta.canonical_id === candidate.rule.canonicalId) {
        return true;
      }
      const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || entry.text, meta.memory_category);
      return inferred?.topic === candidate.rule.topic;
    });

    const exact = sameTopic.find((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || entry.text, meta.memory_category);
      return inferred?.normalizedText === candidate.rule.normalizedText;
    });

    const conflictingEntries = sameTopic.filter((entry) => {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const inferred = inferGovernanceRuleFromMemory(meta.l0_abstract || entry.text, meta.memory_category);
      return rulesConflict(inferred, candidate.rule);
    });

    if (exact) {
      const meta = parseSmartMetadata(exact.metadata, exact);
      const next = buildSmartMetadata(exact, {
        canonical_id: candidate.rule.canonicalId,
        confidence: Math.max(Number(meta.confidence ?? 0.7), candidate.confidence),
        evidence_count: Math.max(Number(meta.evidence_count ?? 0), candidate.evidenceCount),
        stability_score: Math.max(Number(meta.stability_score ?? 0), candidate.stabilityScore),
        distilled_from: Array.from(new Set([...(Array.isArray(meta.distilled_from) ? meta.distilled_from : []), ...candidate.evidenceIds])).slice(-12),
        source_reason: "preference_distiller",
      });
      await deps.store.update(exact.id, { metadata: stringifySmartMetadata(next) }, scopeFilter);
      result.updated++;
      for (const conflicting of conflictingEntries) {
        const conflictingMeta = parseSmartMetadata(conflicting.metadata, conflicting);
        if (candidate.confidence < Number(conflictingMeta.confidence ?? 0.7)) continue;
        const archived = buildSmartMetadata(conflicting, {
          state: "archived",
          memory_layer: "archive",
          invalidated_at: Date.now(),
          superseded_by: exact.id,
          prune_reason: "contradiction_newer_version",
        });
        await deps.store.update(conflicting.id, { metadata: stringifySmartMetadata(archived) }, scopeFilter);
        result.superseded++;
      }
      continue;
    }

    const conflicting = conflictingEntries[0];

    if (conflicting) {
      const conflictingMeta = parseSmartMetadata(conflicting.metadata, conflicting);
      const currentConfidence = Number(conflictingMeta.confidence ?? 0.7);
      if (candidate.confidence < currentConfidence) {
        result.skipped++;
        continue;
      }

      const now = Date.now();
      const next = buildSmartMetadata(conflicting, {
        l0_abstract: candidate.rule.text,
        l1_overview: `- ${candidate.rule.text}`,
        l2_content: candidate.rule.text,
        memory_category: candidate.rule.memoryCategory,
        confidence: candidate.confidence,
        source_reason: "preference_distiller",
        source_session: candidate.latestSessionMarker,
        stability_score: candidate.stabilityScore,
        evidence_count: candidate.evidenceCount,
        distilled_from: Array.from(new Set([...(Array.isArray(conflictingMeta.distilled_from) ? conflictingMeta.distilled_from : []), ...candidate.evidenceIds])).slice(-12),
        canonical_id: candidate.rule.canonicalId,
        state: "confirmed",
        memory_layer: candidate.rule.memoryCategory === "preferences" ? "durable" : "working",
        last_confirmed_use_at: now,
      });
      await deps.store.update(conflicting.id, {
        text: candidate.rule.text,
        importance: Math.max(conflicting.importance, candidate.rule.memoryCategory === "preferences" ? 0.85 : 0.8),
        category: candidate.rule.storeCategory,
        metadata: stringifySmartMetadata(next),
      }, scopeFilter);
      result.updated++;
      continue;
    }

    result.skipped++;
  }

  deps.logger?.info?.(
    `memory-preference-distiller: scanned=${result.scanned} sessions=${result.sessionsConsidered} ` +
      `candidates=${result.candidates} created=${result.created} updated=${result.updated} ` +
      `superseded=${result.superseded} skipped=${result.skipped}`,
  );

  return result;
}
