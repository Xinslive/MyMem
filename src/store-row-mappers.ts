import type { MemoryEntry } from "./store-types.js";

export function toLanceRows(entries: MemoryEntry[]): Record<string, unknown>[] {
  return entries.map((entry) => ({ ...entry }));
}

export function toNumberVector(value: unknown): number[] {
  if (!value) return [];
  const maybeIterable = value as Iterable<unknown>;
  if (typeof maybeIterable[Symbol.iterator] !== "function") return [];
  return Array.from(maybeIterable, (item) => Number(item));
}

export function mapRowToMemoryEntry(row: any, includeVector = true): MemoryEntry {
  return {
    id: row.id as string,
    text: row.text as string,
    vector: includeVector ? toNumberVector(row.vector) : [],
    category: row.category as MemoryEntry["category"],
    scope: (row.scope as string | undefined) ?? "global",
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: (row.metadata as string) || "{}",
  };
}
