import { Type, type Static } from "@sinclair/typebox";
import type { Logger } from "./logger.js";
import type { SmartMemoryMetadata } from "./smart-metadata.js";
import { MEMORY_CATEGORIES } from "./memory-categories.js";

// ============================================================================
// LanceDB Type Stubs
// ============================================================================

/** LanceDB row shape returned by query().toArray() — loosely typed because
 *  LanceDB's own types are incomplete for Arrow-backed vectors. */
export interface LanceRow {
  id: string;
  text: string;
  vector: unknown; // Arrow Vector — converted via toNumberVector()
  category: string;
  scope?: string;
  importance: number;
  timestamp: number;
  metadata: string;
  [key: string]: unknown;
}

/** LanceDB index metadata returned by table.listIndices(). */
export interface LanceIndex {
  name: string;
  indexType: string;
  columns: string[];
  [key: string]: unknown;
}

export const STORE_CATEGORY_VALUES = [
  ...MEMORY_CATEGORIES,
  "reflection",
] as const;

export type StoreCategory = (typeof STORE_CATEGORY_VALUES)[number];

export const MemoryEntrySchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  vector: Type.Array(Type.Number()),
  category: Type.Union(STORE_CATEGORY_VALUES.map((category) => Type.Literal(category))),
  scope: Type.String(),
  importance: Type.Number(),
  timestamp: Type.Number(),
  metadata: Type.Optional(Type.String()),
});

export type MemoryEntry = Static<typeof MemoryEntrySchema> & {
  /** Cached parsed metadata — avoids repeated JSON.parse across retrieval pipeline. */
  _parsedMeta?: SmartMemoryMetadata;
};

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryListFilters {
  quality?: "bad_recall" | "suppressed" | "low_confidence" | "inactive";
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  /** Optional logger instance. If not provided, uses default console-based logger. */
  logger?: Logger;
  /**
   * Allow writes whose top-level category is `reflection`.
   *
   * The main memory store leaves this unset so reflection/session data cannot
   * leak into normal recall. The dedicated reflection store enables it.
   */
  allowReflectionCategory?: boolean;
  /** Enable append-only mutation audit log. Defaults to true. */
  auditLogEnabled?: boolean;
  /** Optional audit JSONL path. Defaults to `<dbPath>/audit.jsonl`. */
  auditLogPath?: string;
}

export interface MetadataPatch {
  [key: string]: unknown;
}

export interface StoreIndexStatus {
  totalRows: number;
  totalIndices: number;
  names: string[];
  available: {
    fts: boolean;
    vector: boolean;
    scalar: string[];
  };
  exhaustiveVectorSearch: boolean;
  missingRecommendedScalars: string[];
  vectorIndexPending: boolean;
}
