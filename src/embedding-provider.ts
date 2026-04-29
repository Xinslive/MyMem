export type EmbeddingProviderProfile =
  | "openai"
  | "azure-openai"
  | "jina"
  | "voyage-compatible"
  | "nvidia"
  | "generic-openai-compatible";

export interface EmbeddingCapabilities {
  /** Whether to send encoding_format: "float" */
  encoding_format: boolean;
  /** Whether to send normalized (Jina-style) */
  normalized: boolean;
  /**
   * Field name to use for the task/input-type hint, or null if unsupported.
   * e.g. "task" for Jina, "input_type" for Voyage, null for OpenAI/generic.
   * If a taskValueMap is provided, task values are translated before sending.
   */
  taskField: string | null;
  /** Optional value translation map for taskField (e.g. Voyage needs "retrieval.query" → "query") */
  taskValueMap?: Record<string, string>;
  /**
   * Field name to use for the requested output dimension, or null if unsupported.
   * e.g. "dimensions" for OpenAI, "output_dimension" for Voyage, null if not supported.
   */
  dimensionsField: string | null;
}

// Known embedding model dimensions
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "BAAI/bge-m3": 1024,
  "all-MiniLM-L6-v2": 384,
  "all-mpnet-base-v2": 512,

  // Jina v5
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,

  // Voyage recommended models
  "voyage-4": 1024,
  "voyage-4-lite": 1024,
  "voyage-4-large": 1024,

  // Voyage legacy models
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-3-large": 1024,
};

export function getProviderLabel(baseURL: string | undefined, model: string): string {
  const profile = detectEmbeddingProviderProfile(baseURL, model);
  const base = baseURL || "";

  if (/localhost:11434|127\.0\.0\.1:11434|\/ollama\b/i.test(base)) return "Ollama";

  if (base) {
    if (profile === "jina" && /api\.jina\.ai/i.test(base)) return "Jina";
    if (profile === "voyage-compatible" && /api\.voyageai\.com/i.test(base)) return "Voyage";
    if (profile === "openai" && /api\.openai\.com/i.test(base)) return "OpenAI";
    if (profile === "azure-openai" || /\.openai\.azure\.com/i.test(base)) return "Azure OpenAI";
    if (profile === "nvidia") return "NVIDIA NIM";

    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  }

  switch (profile) {
    case "jina":
      return "Jina";
    case "voyage-compatible":
      return "Voyage";
    case "openai":
    case "azure-openai":
      return "OpenAI";
    case "nvidia":
      return "NVIDIA NIM";
    default:
      return "embedding provider";
  }
}

export function isLoopbackBaseURL(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const parsed = new URL(baseURL);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

export function detectEmbeddingProviderProfile(
  baseURL: string | undefined,
  model: string,
): EmbeddingProviderProfile {
  const base = baseURL || "";
  let host = "";
  try { host = new URL(base).hostname.toLowerCase(); } catch { /* invalid URL — skip host checks */ }

  // Host-based detection runs first — endpoint owner semantics take precedence
  // over model-name heuristics to avoid misclassifying e.g. a jina-xxx model
  // served from .nvidia.com as Jina instead of NVIDIA.
  // Match on parsed hostname to avoid false positives from proxy URLs that
  // contain provider domains in their path or query string.
  if (host.endsWith("api.openai.com")) return "openai";
  if (host.endsWith(".openai.azure.com")) return "azure-openai";
  if (host.endsWith("api.jina.ai")) return "jina";
  if (host.endsWith("api.voyageai.com")) return "voyage-compatible";
  if (host.endsWith(".nvidia.com") || host === "nvidia.com") return "nvidia";

  // Model-prefix fallback — only when baseURL didn't match a known host
  if (/^jina-/i.test(model)) return "jina";
  if (/^voyage\b/i.test(model)) return "voyage-compatible";
  if (/^nvidia\//i.test(model) || /^nv-embed/i.test(model)) return "nvidia";

  return "generic-openai-compatible";
}

export function getEmbeddingCapabilities(profile: EmbeddingProviderProfile): EmbeddingCapabilities {
  switch (profile) {
    case "openai":
      return {
        encoding_format: true,
        normalized: false,
        taskField: null,
        dimensionsField: "dimensions",
      };
    case "jina":
      return {
        encoding_format: true,
        normalized: true,
        taskField: "task",
        dimensionsField: "dimensions",
      };
    case "voyage-compatible":
      return {
        encoding_format: false,
        normalized: false,
        taskField: "input_type",
        taskValueMap: {
          "retrieval.query": "query",
          "retrieval.passage": "document",
          "query": "query",
          "document": "document",
        },
        dimensionsField: "output_dimension",
      };
    case "nvidia":
      return {
        encoding_format: true,
        normalized: false,
        taskField: "input_type",
        taskValueMap: {
          "retrieval.query": "query",
          "retrieval.passage": "passage",
          "query": "query",
          "passage": "passage",
        },
        dimensionsField: "dimensions",
      };
    case "generic-openai-compatible":
    default:
      return {
        encoding_format: true,
        normalized: false,
        taskField: null,
        dimensionsField: "dimensions",
      };
  }
}
