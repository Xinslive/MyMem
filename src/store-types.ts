import type { Logger } from "./logger.js";
import type { SmartMemoryMetadata } from "./smart-metadata.js";

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
