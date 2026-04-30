import type { Logger } from "./logger.js";
import type { SmartMemoryMetadata } from "./smart-metadata.js";

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

/** Extended LanceDB module shape covering the Index builder.
 *  LanceDB exports `Index` as a class but the module type doesn't expose it. */
export interface LanceDbExtended {
  Index: {
    bitmap(): unknown;
    btree(): unknown;
    ivfFlat(config: { distanceType: string; numPartitions: number }): unknown;
    fts(config: unknown): unknown;
  };
}

/** LanceDB index metadata returned by table.listIndices(). */
export interface LanceIndex {
  name: string;
  indexType: string;
  columns: string[];
  [key: string]: unknown;
}

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string; // JSON string for extensible metadata
  /** Cached parsed metadata — avoids repeated JSON.parse across retrieval pipeline. */
  _parsedMeta?: SmartMemoryMetadata;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  /** Optional logger instance. If not provided, uses default console-based logger. */
  logger?: Logger;
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
