import { normalizeCategory } from "./memory-categories.js";
import { parseSmartMetadata } from "./smart-metadata.js";

export function parseReflectionMetadata(metadataRaw: string | undefined): Record<string, unknown> {
  if (!metadataRaw) return {};
  try {
    const parsed = JSON.parse(metadataRaw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function isReflectionEntry(entry: { category: string; metadata?: string }): boolean {
  if (entry.category === "reflection") return true;
  const metadata = parseReflectionMetadata(entry.metadata);
  return metadata.type === "memory-reflection" ||
    metadata.type === "memory-reflection-event" ||
    metadata.type === "memory-reflection-item";
}

export function getDisplayCategoryTag(entry: { category: string; scope: string; metadata?: string }): string {
  if (isReflectionEntry(entry)) return `reflection:${entry.scope}`;
  const meta = parseSmartMetadata(entry.metadata, entry as Parameters<typeof parseSmartMetadata>[1]);
  const category = normalizeCategory(meta.memory_category) ?? entry.category;
  return `${category}:${entry.scope}`;
}
