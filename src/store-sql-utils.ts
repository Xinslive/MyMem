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
  const nullScopeCondition = scopeFilter.includes("global") ? " OR scope IS NULL" : "";
  return `((${scopeConditions})${nullScopeCondition})`;
}

export function combineWhereClauses(parts: Array<string | null | undefined>): string | undefined {
  const filtered = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return filtered.length > 0 ? filtered.join(" AND ") : undefined;
}

export function prefixWhereClause(column: string, prefix: string): string {
  const safePrefix = escapeSqlLiteral(prefix).replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `${column} LIKE '${safePrefix}%'`;
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
  // Audit #10: raise upper bound from 256 to 1024 for 100K+ datasets.
  // IVF standard: partitions ≈ 4*sqrt(N). 10K rows → ~128, 100K → ~400.
  const rough = Math.max(8, Math.min(1024, Math.round(sqrt)));
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
const CJK_RE = /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const TOKEN_SET_CACHE_MAX_ENTRIES = 2_048;
const TOKEN_SET_CACHE_MAX_CHARS = 4_096;
const EMPTY_TOKEN_SET: ReadonlySet<string> = new Set();
const tokenSetCache = new Map<string, ReadonlySet<string>>();

export function tokenizeForSearch(text: string): string[] {
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

export function tokenSetForSearch(normalizedText: string): ReadonlySet<string> {
  if (!normalizedText) return EMPTY_TOKEN_SET;
  if (normalizedText.length > TOKEN_SET_CACHE_MAX_CHARS) {
    return new Set(tokenizeForSearch(normalizedText));
  }

  const cached = tokenSetCache.get(normalizedText);
  if (cached) {
    tokenSetCache.delete(normalizedText);
    tokenSetCache.set(normalizedText, cached);
    return cached;
  }

  const tokens = new Set(tokenizeForSearch(normalizedText));
  tokenSetCache.set(normalizedText, tokens);
  if (tokenSetCache.size > TOKEN_SET_CACHE_MAX_ENTRIES) {
    const oldestKey = tokenSetCache.keys().next().value;
    if (oldestKey !== undefined) tokenSetCache.delete(oldestKey);
  }
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

  const queryTokenSet = tokenSetForSearch(normalizedQuery);
  if (queryTokenSet.size === 0) return 0;

  const querySize = queryTokenSet.size;

  let bestScore = 0;
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const normalized = normalizeSearchText(candidate.text);
    if (!normalized) continue;

    // Token-based matching: count how many unique query tokens appear in candidate
    const candidateTokenSet = tokenSetForSearch(normalized);
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

/**
 * Pre-tokenized variant of scoreLexicalHit. Accepts already-tokenized query
 * and candidate tokens to avoid redundant tokenizeForSearch() calls when the
 * same query is scored against many candidates.
 */
export function scoreLexicalHitPreTokenized(
  queryTokens: ReadonlySet<string>,
  candidates: Array<{ tokens: ReadonlySet<string>; weight: number; normalized: string }>,
  normalizedQuery: string,
): number {
  if (queryTokens.size === 0) return 0;
  const querySize = queryTokens.size;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate.tokens.size === 0) continue;
    let matchedTokens = 0;
    for (const qt of queryTokens) {
      if (candidate.tokens.has(qt)) matchedTokens++;
    }
    if (matchedTokens === 0) continue;
    const coverage = matchedTokens / querySize;
    let score = 0.5 + 0.42 * coverage;
    if (candidate.normalized.includes(normalizedQuery)) score = Math.max(score, 0.88);
    if (coverage === 1) score = Math.max(score, 0.92);
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

/**
 * Validate that a vector is a plain array of finite numbers with the
 * expected dimensionality. Throws a descriptive error when:
 *   - the vector is empty (would be invisible to all vector searches)
 *   - the vector length does not match the configured `vectorDim`
 *   - the input is not an array (e.g. an Arrow Vector was passed in)
 *
 * Audit #5: previously a failed embedder would leave `vector: []` (or
 * undefined) and the store would happily write the row. The memory then
 * could never be retrieved by vector search and `cosineSimilarity(_, [])`
 * produced NaN which corrupted scoring. This guard makes those failures
 * loud at the write site so callers (smart-extractor, tools, etc.) can
 * decide whether to retry, skip, or surface an error to the user.
 */
export function assertValidVector(
  vector: number[] | undefined | null,
  expectedDim: number,
  operation: string,
): void {
  if (!Array.isArray(vector)) {
    throw new Error(
      `${operation}: expected vector to be an array, got ${vector === null ? "null" : typeof vector}`,
    );
  }
  if (vector.length === 0) {
    throw new Error(
      `${operation}: refused to write a zero-length vector (memory would be invisible to vector search; usually caused by an embedder failure — see audit #5)`,
    );
  }
  if (vector.length !== expectedDim) {
    throw new Error(
      `${operation}: vector dimension mismatch: expected ${expectedDim}, got ${vector.length}`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(
        `${operation}: vector contains non-finite value at index ${i} (likely a failed embedder call)`,
      );
    }
  }
}
