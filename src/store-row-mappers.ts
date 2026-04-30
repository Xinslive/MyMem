import type { MemoryEntry, LanceRow } from "./store-types.js";
import { parseSmartMetadata } from "./smart-metadata.js";

export function toLanceRows(entries: MemoryEntry[]): Record<string, unknown>[] {
  // Strip internal cache fields before writing to LanceDB
  return entries.map((entry) => {
    const { _parsedMeta, ...rest } = entry;
    void _parsedMeta; // explicitly unused — just stripped
    return { ...rest };
  });
}

export function toNumberVector(value: unknown): number[] {
  if (!value) return [];
  const maybeIterable = value as Iterable<unknown>;
  if (typeof maybeIterable[Symbol.iterator] !== "function") return [];
  return Array.from(maybeIterable, (item) => Number(item));
}

export function mapRowToMemoryEntry(row: LanceRow, includeVector = true): MemoryEntry {
  const entry: MemoryEntry = {
    id: row.id as string,
    text: row.text as string,
    vector: includeVector ? toNumberVector(row.vector) : [],
    category: row.category as MemoryEntry["category"],
    scope: (row.scope as string | undefined) ?? "global",
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: (row.metadata as string) || "{}",
  };
  // Eagerly parse and cache metadata to avoid repeated JSON.parse downstream
  entry._parsedMeta = parseSmartMetadata(entry.metadata, entry);
  return entry;
}
