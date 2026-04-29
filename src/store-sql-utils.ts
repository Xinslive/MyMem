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

export function isVectorIndexType(indexType: string): boolean {
  return /ivf|hnsw|pq|sq|vector/i.test(indexType);
}

export function isScalarIndexType(indexType: string): boolean {
  return /btree|bitmap|label/i.test(indexType);
}

export function recommendedVectorPartitions(totalRows: number): number {
  const sqrt = Math.sqrt(Math.max(totalRows, 1));
  const rough = Math.max(8, Math.min(256, Math.round(sqrt)));
  return Math.max(8, Math.pow(2, Math.round(Math.log2(rough))));
}

export function scoreLexicalHit(query: string, candidates: Array<{ text: string; weight: number }>): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  let score = 0;
  for (const candidate of candidates) {
    const normalized = normalizeSearchText(candidate.text);
    if (!normalized) continue;
    if (normalized.includes(normalizedQuery)) {
      score = Math.max(score, Math.min(0.95, 0.72 + normalizedQuery.length * 0.02) * candidate.weight);
    }
  }

  return score;
}
