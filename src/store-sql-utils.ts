export const FULL_ENTRY_COLUMNS = [
  "id",
  "text",
  "vector",
  "category",
  "scope",
  "importance",
  "timestamp",
  "metadata",
] as const;

export const LIST_ENTRY_COLUMNS = [
  "id",
  "text",
  "category",
  "scope",
  "importance",
  "timestamp",
  "metadata",
] as const;

export const DEFAULT_SCALAR_INDEX_COLUMNS = ["id", "scope", "category", "timestamp"] as const;
export const MIN_VECTOR_INDEX_ROWS = 64;

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

export function isExplicitDenyAllScopeFilter(scopeFilter?: string[]): boolean {
  return Array.isArray(scopeFilter) && scopeFilter.length === 0;
}

export function buildScopeWhereClause(scopeFilter?: string[]): string | null {
  if (!scopeFilter || scopeFilter.length === 0) return null;
  const scopeConditions = scopeFilter
    .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
    .join(" OR ");
  return `((${scopeConditions}) OR scope IS NULL)`;
}

export function combineWhereClauses(parts: Array<string | null | undefined>): string | undefined {
  const filtered = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return filtered.length > 0 ? filtered.join(" AND ") : undefined;
}

export function prefixWhereClause(column: string, prefix: string): string {
  return `${column} LIKE '${escapeSqlLiteral(prefix)}%'`;
}

// Pre-compiled regex for index type detection (called in hot loops during index listing)
const VECTOR_INDEX_RE = /ivf|hnsw|pq|sq|vector/i;
const SCALAR_INDEX_RE = /btree|bitmap|label/i;

export function isVectorIndexType(indexType: string): boolean {
  return VECTOR_INDEX_RE.test(indexType);
}

export function isScalarIndexType(indexType: string): boolean {
  return SCALAR_INDEX_RE.test(indexType);
}

export function recommendedVectorPartitions(totalRows: number): number {
  const sqrt = Math.sqrt(Math.max(totalRows, 1));
  const rough = Math.max(8, Math.min(256, Math.round(sqrt)));
  return Math.max(8, Math.pow(2, Math.round(Math.log2(rough))));
}

/**
 * Tokenize text into lowercase terms. Handles CJK characters as individual
 * tokens plus bigrams for better semantic matching, and splits Latin text
 * on word boundaries.
 *
 * CJK bigrams: "部署了" → ["部", "署", "了", "部署", "署了"]
 * This allows queries like "部署" to match "部署了新版本" via bigram overlap.
 */
// Pre-compiled regex for CJK character detection (hot path in tokenizeForSearch)
const CJK_RE = /[一-鿿㐀-䶿㐀-䶿-䶿぀-ゟ゠-ヿ가-힯]/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function tokenizeForSearch(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let current = "";
  let prevCjk = "";

  for (const ch of lower) {
    // CJK character → individual token + bigram with previous CJK
    if (CJK_RE.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      tokens.push(ch);
      if (prevCjk) {
        tokens.push(prevCjk + ch);
      }
      prevCjk = ch;
      continue;
    }
    // Word character → accumulate
    if (WORD_CHAR_RE.test(ch)) {
      current += ch;
      prevCjk = "";
      continue;
    }
    // Separator → flush
    if (current) { tokens.push(current); current = ""; }
    prevCjk = "";
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Token-based lexical scoring with coverage weighting.
 *
 * Improvements over the old substring-match approach:
 * - Order-independent: "deploy config" matches "config deploy"
 * - Per-term matching: partial matches still score
 * - Coverage-based: score proportional to matched query terms
 * - Exact substring bonus preserved for backward compatibility
 */
export function scoreLexicalHit(query: string, candidates: Array<{ text: string; weight: number }>): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const queryTokens = tokenizeForSearch(normalizedQuery);
  if (queryTokens.length === 0) return 0;

  // Deduplicate query tokens for coverage calculation
  const queryTokenSet = new Set(queryTokens);
  const querySize = queryTokenSet.size;

  let bestScore = 0;
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const normalized = normalizeSearchText(candidate.text);
    if (!normalized) continue;

    // Token-based matching: count how many unique query tokens appear in candidate
    const candidateTokenSet = new Set(tokenizeForSearch(normalized));
    let matchedTokens = 0;
    for (const qt of queryTokenSet) {
      if (candidateTokenSet.has(qt)) matchedTokens++;
    }

    if (matchedTokens === 0) continue;

    // Coverage: fraction of query tokens found
    const coverage = matchedTokens / querySize;

    // Base score from coverage (0.5 ~ 0.92)
    let score = 0.5 + 0.42 * coverage;

    // Exact substring bonus (backward compat: rewards precise matches)
    if (normalized.includes(normalizedQuery)) {
      score = Math.max(score, 0.88);
    }

    // Full coverage bonus
    if (coverage === 1) {
      score = Math.max(score, 0.92);
    }

    bestScore = Math.max(bestScore, Math.min(0.95, score) * candidate.weight);
  }

  return bestScore;
}

// ── ID Resolution ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f]{8,}$/i;

export interface ResolvedMemoryId {
  /** The original input ID. */
  raw: string;
  /** true when the ID is a full UUID; false when it's a short prefix. */
  isFullId: boolean;
}

/**
 * Validate and classify a memory ID as either a full UUID or a short hex prefix.
 * Throws on invalid format.
 */
export function resolveMemoryId(id: string): ResolvedMemoryId {
  const isFullId = UUID_RE.test(id);
  if (isFullId) return { raw: id, isFullId: true };

  if (PREFIX_RE.test(id)) return { raw: id, isFullId: false };

  throw new Error(`Invalid memory ID format: ${id}`);
}
