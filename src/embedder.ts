/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers.
 * Supports automatic chunking for documents exceeding embedding context limits.
 *
 * Note: Some providers (e.g. Jina) support extra parameters like `task` and
 * `normalized` on the embeddings endpoint. The OpenAI SDK types do not include
 * these fields, so we pass them via a narrow `any` cast.
 */

import OpenAI from "openai";
import { smartChunk } from "./chunker.js";
import { EmbeddingCache } from "./embedding-cache.js";
import {
  ConcurrencyLimiter,
  globalEmbedRequestLimiter,
  EMBED_TIMEOUT_MS,
  GLOBAL_EMBED_CONCURRENCY_LIMIT,
  MAX_EMBED_DEPTH,
  STRICT_REDUCTION_FACTOR,
} from "./concurrency-limiter.js";
import {
  detectEmbeddingProviderProfile,
  getEmbeddingCapabilities,
  isLoopbackBaseURL,
  EMBEDDING_DIMENSIONS,
} from "./embedding-provider.js";
import {
  formatEmbeddingProviderError,
  getErrorMessage,
  getErrorStatus,
  getErrorCode,
  isAuthError,
  isNetworkError,
  isAbortError,
} from "./embedding-error-utils.js";
import type { Logger } from "./logger.js";

// Re-export for backward compat
export { formatEmbeddingProviderError };

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: "openai-compatible" | "azure-openai";
  apiVersion?: string;
  /** Single API key or array of keys for round-robin rotation with failover. */
  apiKey: string | string[];
  model: string;
  baseURL?: string;
  dimensions?: number;

  /** Optional task type for query embeddings (e.g. "retrieval.query") */
  taskQuery?: string;
  /** Optional task type for passage/document embeddings (e.g. "retrieval.passage") */
  taskPassage?: string;
  /** Optional flag to request normalized embeddings (provider-dependent, e.g. Jina v5) */
  normalized?: boolean;
  /** When true, omit the dimensions parameter from embedding requests even if dimensions is set.
   *  Use this for local models that reject the dimensions parameter with "matryoshka representation" errors. */
  omitDimensions?: boolean;
  /** Enable automatic chunking for documents exceeding context limits (default: true) */
  chunking?: boolean;
  /** Embedding cache configuration */
  cache?: {
    /** Maximum number of cache entries (default: 256) */
    maxSize?: number;
    /** Cache TTL in minutes (default: 30) */
    ttlMinutes?: number;
  };
  /** Optional logger. OpenClaw passes its host logger; CLI/tests can omit it. */
  logger?: Pick<Logger, "debug" | "info" | "warn">;
}

const fallbackLogger: Pick<Logger, "debug" | "info" | "warn"> = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.log(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }

  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Either add it to EMBEDDING_DIMENSIONS or set embedding.dimensions in config.`
    );
  }

  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  /** Pool of OpenAI clients — one per API key for round-robin rotation. */
  private clients: OpenAI[];
  /** Round-robin index for client rotation. */
  private _clientIndex: number = 0;

  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;

  private readonly _model: string;
  private readonly _baseURL?: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;
  private readonly _capabilities: ReturnType<typeof getEmbeddingCapabilities>;

  /** Optional requested dimensions to pass through to the embedding provider (OpenAI-compatible). */
  private readonly _requestDimensions?: number;
  /** When true, omit the dimensions parameter even if _requestDimensions is set. */
  private readonly _omitDimensions: boolean;
  /** Enable automatic chunking for long documents (default: true) */
  private readonly _autoChunk: boolean;
  private readonly _logger: Pick<Logger, "debug" | "info" | "warn">;
  private readonly _inflightSingle = new Map<string, Promise<number[]>>();
  private readonly _signalIds = new WeakMap<AbortSignal, number>();
  private _nextSignalId = 1;

  constructor(config: EmbeddingConfig & { chunking?: boolean }) {
    // Normalize apiKey to array and resolve environment variables
    const apiKeys = Array.isArray(config.apiKey) ? config.apiKey : [config.apiKey];
    const resolvedKeys = apiKeys.map(k => resolveEnvVars(k));

    this._model = config.model;
    this._baseURL = config.baseURL;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;
    this._omitDimensions = config.omitDimensions === true;
    // Enable auto-chunking by default for better handling of long documents
    this._autoChunk = config.chunking !== false;
    this._logger = config.logger ?? fallbackLogger;
    const profile = detectEmbeddingProviderProfile(this._baseURL, this._model);
    this._capabilities = getEmbeddingCapabilities(profile);

    // Warn if configured fields will be silently ignored by this provider profile
    if (config.normalized !== undefined && !this._capabilities.normalized) {
      this._logger.debug(
        `[mymem] embedding.normalized is set but provider profile "${profile}" does not support it — value will be ignored`
      );
    }
    if ((config.taskQuery || config.taskPassage) && !this._capabilities.taskField) {
      this._logger.debug(
        `[mymem] embedding.taskQuery/taskPassage is set but provider profile "${profile}" does not support task hints — values will be ignored`
      );
    }

    // Create a client pool — one OpenAI client per key
    this.clients = resolvedKeys.map(key => {
      let defaultHeaders: Record<string, string> = {};
      let baseURL = config.baseURL;

      if (config.provider === "azure-openai" || profile === "azure-openai") {
        defaultHeaders["api-key"] = key;
        if (baseURL && config.apiVersion) {
          const url = new URL(baseURL);
          url.searchParams.set("api-version", config.apiVersion);
          baseURL = url.toString();
        }
      }

      return new OpenAI({
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
      });
    });

    if (this.clients.length > 1) {
      this._logger.info(`[mymem] Initialized ${this.clients.length} API keys for round-robin rotation`);
    }

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    const cacheConfig = config.cache ?? {};
    this._cache = new EmbeddingCache(
      cacheConfig.maxSize ?? 256,
      cacheConfig.ttlMinutes ?? 30,
    );
  }

  // --------------------------------------------------------------------------
  // Multi-key rotation helpers
  // --------------------------------------------------------------------------

  /** Return the next client in round-robin order. */
  private nextClient(): OpenAI {
    const client = this.clients[this._clientIndex % this.clients.length];
    this._clientIndex = (this._clientIndex + 1) % this.clients.length;
    return client;
  }

  /** Check whether an error is a rate-limit / quota-exceeded / overload error. */
  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    const err = error as Record<string, any>;

    // HTTP status: 429 (rate limit) or 503 (service overload)
    if (err.status === 429 || err.status === 503) return true;

    // OpenAI SDK structured error code
    if (err.code === "rate_limit_exceeded" || err.code === "insufficient_quota") return true;

    // Nested error object (some providers)
    const nested = err.error;
    if (nested && typeof nested === "object") {
      if (nested.type === "rate_limit_exceeded" || nested.type === "insufficient_quota") return true;
      if (nested.code === "rate_limit_exceeded" || nested.code === "insufficient_quota") return true;
    }

    // Fallback: message text matching
    const msg = error instanceof Error ? error.message : String(error);
    return /rate.limit|quota|too many requests|insufficient.*credit|429|503.*overload/i.test(msg);
  }

  /**
   * Detect if the configured baseURL points to a local Ollama instance.
   * Ollama's HTTP server does not properly handle AbortController signals through
   * the OpenAI SDK's HTTP client, causing long-lived sockets that don't close
   * when the embedding pipeline times out. For Ollama we use native fetch instead.
   */
  private isOllamaProvider(): boolean {
    if (!this._baseURL) return false;
    return /localhost:11434|127\.0\.0\.1:11434|\/ollama\b/i.test(this._baseURL);
  }

  /** Serialize provider-bound work through a shared global concurrency gate. */
  private async withGlobalConcurrencyLimit<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await globalEmbedRequestLimiter.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Call embeddings.create using native fetch (bypasses OpenAI SDK).
   * Used exclusively for Ollama endpoints where AbortController must work
   * correctly to avoid long-lived stalled sockets.
   *
   * For Ollama 0.20.5+: /v1/embeddings may return empty arrays for some models,
   * so we use /api/embeddings with "prompt" field for single requests (PR #621).
   * For batch requests, we use /v1/embeddings with "input" array as it's more
   * efficient and confirmed working in local testing.
   *
   * See: https://github.com/Xinslive/MyMem/issues/620
   * Fix: https://github.com/Xinslive/MyMem/issues/629
   */
  private async embedWithNativeFetch(payload: any, signal?: AbortSignal): Promise<any> {
    if (!this._baseURL) {
      throw new Error("embedWithNativeFetch requires a baseURL");
    }

    const base = this._baseURL.replace(/\/$/, "").replace(/\/v1$/, "");
    const apiKey = this.clients[0]?.apiKey ?? "ollama";

    // Handle batch requests with /v1/embeddings + input array
    // NOTE: /v1/embeddings is used unconditionally for batch with no fallback.
    // If a model doesn't support that endpoint, failure will be silent from the user's perspective.
    // This is acceptable because most Ollama embedding models support /v1/embeddings.
    if (Array.isArray(payload.input)) {
      const response = await this.withGlobalConcurrencyLimit(
        () => fetch(base + "/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: payload.model,
            input: payload.input,
            // NOTE: Other provider options (encoding_format, normalized, dimensions, etc.)
            // from buildPayload() are intentionally not included. Ollama embedding models
            // do not support these parameters, so omitting them is correct.
          }),
          signal,
        }),
        signal,
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Ollama batch embedding failed: ${response.status} ${response.statusText} ??${body.slice(0, 200)}`
        );
      }

      const data = await response.json();

      // Validate response count and non-empty embeddings
      if (
        !Array.isArray(data?.data) ||
        data.data.length !== payload.input.length ||
        data.data.some((item: any) => {
          const embedding = item?.embedding;
          return !Array.isArray(embedding) || embedding.length === 0;
        })
      ) {
        throw new Error(
          `Ollama batch embedding returned invalid response for ${payload.input.length} inputs`
        );
      }

      return data;
    }

    // Single request: use /api/embeddings + prompt (PR #621 fix)
    const response = await this.withGlobalConcurrencyLimit(
      () => fetch(base + "/api/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: payload.model,
          prompt: payload.input,
        }),
        signal,
      }),
      signal,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Ollama embedding failed: ${response.status} ${response.statusText} ??${body.slice(0, 200)}`
      );
    }

    const data = await response.json();

    // Ollama /api/embeddings returns { embedding: number[] },
    // convert to OpenAI-compatible shape { data: [{ embedding: number[] }] }
    return { data: [{ embedding: data.embedding }] };
  }

  /**
   * Call embeddings.create with automatic key rotation on rate-limit errors.
   * Tries each key in the pool at most once before giving up.
   * Accepts an optional AbortSignal to support true request cancellation.
   *
   * For Ollama endpoints, native fetch is used instead of the OpenAI SDK
   * because AbortController does not reliably abort Ollama's HTTP connections
   * through the SDK's HTTP client on Node.js.
   */
  private async embedWithRetry(payload: any, signal?: AbortSignal): Promise<any> {
    // Use native fetch for Ollama to ensure proper AbortController support
    if (this.isOllamaProvider()) {
      try {
        return await this.embedWithNativeFetch(payload, signal);
      } catch (error) {
        // Only retry Ollama on network/timeout errors, not user abort
        if (isAbortError(error) && signal?.aborted) {
          throw error;
        }
        if (isNetworkError(error) || isAbortError(error)) {
          return await this.retryWithBackoff(
            () => this.embedWithNativeFetch(payload, signal),
            signal,
            error,
          );
        }
        throw error;
      }
    }

    const maxAttempts = this.clients.length;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = this.nextClient();
      try {
        // Pass signal to OpenAI SDK if provided (SDK v6+ supports this)
        return await this.withGlobalConcurrencyLimit(
          () => client.embeddings.create(payload, signal ? { signal } : undefined),
          signal,
        );
      } catch (error) {
        // If externally aborted, re-throw immediately
        if (isAbortError(error) && signal?.aborted) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // Rate-limit: rotate to next key immediately
        if (this.isRateLimitError(error) && attempt < maxAttempts - 1) {
          this._logger.info(
            `[mymem] Attempt ${attempt + 1}/${maxAttempts} hit rate limit, rotating to next key...`
          );
          continue;
        }

        // Network error or internal timeout: retry with backoff
        if (isNetworkError(error) || isAbortError(error)) {
          return await this.retryWithBackoff(
            () => this.withGlobalConcurrencyLimit(
              () => client.embeddings.create(payload, signal ? { signal } : undefined),
              signal,
            ),
            signal,
            error,
          );
        }

        // Loopback fallback for non-batch requests
        if (!Array.isArray(payload?.input) && isLoopbackBaseURL(this._baseURL)) {
          try {
            return await this.embedWithNativeFetch(payload, signal);
          } catch (fallbackError) {
            if (isAbortError(fallbackError) && signal?.aborted) {
              throw fallbackError;
            }
          }
        }

        // Auth and other errors: don't retry
        throw error;
      }
    }

    // All keys exhausted with rate-limit errors
    throw new Error(
      `All ${maxAttempts} API keys exhausted (rate limited). Last error: ${lastError?.message || "unknown"}`,
      { cause: lastError }
    );
  }

  /**
   * Retry a transient operation with exponential backoff + jitter.
   * Retries up to 3 times for network errors and internal timeouts.
   * Skips retry if the external signal was aborted (user cancellation).
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    signal: AbortSignal | undefined,
    originalError: unknown,
  ): Promise<T> {
    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let retry = 0; retry < maxRetries; retry++) {
      // Don't retry if externally cancelled
      if (signal?.aborted) {
        throw originalError instanceof Error ? originalError : new Error(String(originalError));
      }

      // Exponential backoff with jitter: 1s, 2s, 4s ± 25%
      const delayMs = baseDelayMs * Math.pow(2, retry);
      const jitter = delayMs * 0.25 * (Math.random() * 2 - 1);
      const sleepMs = Math.max(0, Math.round(delayMs + jitter));

      this._logger.info(
        `[mymem] Retrying embedding after ${sleepMs}ms (attempt ${retry + 1}/${maxRetries}): ${originalError instanceof Error ? originalError.message : String(originalError)}`
      );

      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));

      // Don't retry if externally cancelled during sleep
      if (signal?.aborted) {
        throw originalError instanceof Error ? originalError : new Error(String(originalError));
      }

      try {
        return await fn();
      } catch (error) {
        // If externally aborted during retry, throw original error
        if (isAbortError(error) && signal?.aborted) {
          throw error;
        }
        // If last retry, throw
        if (retry === maxRetries - 1) {
          throw error;
        }
        // Continue retrying for network/timeout errors
        if (!isNetworkError(error) && !isAbortError(error)) {
          throw error;
        }
      }
    }

    // Should not reach here, but throw original error as fallback
    throw originalError instanceof Error ? originalError : new Error(String(originalError));
  }

  /** Number of API keys in the rotation pool. */
  get keyCount(): number {
    return this.clients.length;
  }

  /** Wrap a single embedding operation with a global timeout via AbortSignal. */
  private withTimeout<T>(promiseFactory: (signal: AbortSignal) => Promise<T>, _label: string, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    // If caller passes an external signal, merge it with the internal timeout controller.
    // Either signal aborting will cancel the promise.
    let unsubscribe: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        return Promise.reject(externalSignal.reason ?? new Error("aborted"));
      }
      const handler = () => {
        controller.abort();
        clearTimeout(timeoutId);
      };
      externalSignal.addEventListener("abort", handler, { once: true });
      unsubscribe = () => externalSignal.removeEventListener("abort", handler);
    }

    return promiseFactory(controller.signal).finally(() => {
      clearTimeout(timeoutId);
      unsubscribe?.();
    });
  }

  // --------------------------------------------------------------------------
  // Backward-compatible API
  // --------------------------------------------------------------------------

  /**
   * Backward-compatible embedding API.
   *
   * Historically the plugin used a single `embed()` method for both query and
   * passage embeddings. With task-aware providers we treat this as passage.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedPassage(text);
  }

  /** Backward-compatible batch embedding API (treated as passage). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedBatchPassage(texts);
  }

  // --------------------------------------------------------------------------
  // Task-aware API
  // --------------------------------------------------------------------------

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.embedWithInflight(text, this._taskQuery, "embedQuery", signal);
  }

  async embedPassage(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.embedWithInflight(text, this._taskPassage, "embedPassage", signal);
  }

  // Note: embedBatchQuery/embedBatchPassage are NOT wrapped with withTimeout because
  // they handle multiple texts in a single API call. The timeout would fire after
  // EMBED_TIMEOUT_MS regardless of how many texts succeed. Individual text embedding
  // within the batch is protected by the SDK's own timeout handling.
  async embedBatchQuery(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embedMany(texts, this._taskQuery, signal);
  }

  async embedBatchPassage(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embedMany(texts, this._taskPassage, signal);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private validateEmbedding(embedding: number[]): void {
    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding is not an array (got ${typeof embedding})`);
    }
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }
  }

  private buildPayload(input: string | string[], task?: string): any {
    const payload: any = {
      model: this.model,
      input,
    };

    if (this._capabilities.encoding_format) {
      // Force float output where providers explicitly support OpenAI-style formatting.
      payload.encoding_format = "float";
    }

    if (this._capabilities.normalized && this._normalized !== undefined) {
      payload.normalized = this._normalized;
    }

    // Task hint: only injected when BOTH the provider profile defines a taskField
    // AND the caller passes a task value (from user-configured taskQuery/taskPassage).
    // This means broad provider detection (e.g. any .nvidia.com host) is safe —
    // non-retriever models that don't expect input_type are unaffected unless the
    // user explicitly configures task hints.
    const taskField = this._capabilities.taskField;
    if (taskField && task) {
      const value = this._capabilities.taskValueMap?.[task] ?? task;
      payload[taskField] = value;
    }

    // Output dimension: field name is provider-defined.
    // Only sent when explicitly configured, unless omitDimensions is enabled for
    // local or provider-compatible models that reject the dimensions field.
    if (!this._omitDimensions && this._capabilities.dimensionsField && this._requestDimensions && this._requestDimensions > 0) {
      payload[this._capabilities.dimensionsField] = this._requestDimensions;
    }

    return payload;
  }

  private inflightKey(text: string, task?: string, signal?: AbortSignal): string {
    const cacheKey = this._cache.key(text, task);
    if (!signal) return cacheKey;
    let signalId = this._signalIds.get(signal);
    if (!signalId) {
      signalId = this._nextSignalId++;
      this._signalIds.set(signal, signalId);
    }
    return `${cacheKey}:signal:${signalId}`;
  }

  private async embedWithInflight(text: string, task: string | undefined, label: string, signal?: AbortSignal): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    const cached = this._cache.get(text, task);
    if (cached) return cached;

    const inflightKey = this.inflightKey(text, task, signal);
    const inflight = this._inflightSingle.get(inflightKey);
    if (inflight) return inflight;

    const work = this.withTimeout((sig) => this.embedSingle(text, task, 0, sig), label, signal);
    this._inflightSingle.set(inflightKey, work);
    try {
      return await work;
    } finally {
      if (this._inflightSingle.get(inflightKey) === work) {
        this._inflightSingle.delete(inflightKey);
      }
    }
  }

  private async embedSingle(text: string, task?: string, depth: number = 0, signal?: AbortSignal): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    // FR-01: Recursion depth limit — force truncate when too deep
    if (depth >= MAX_EMBED_DEPTH) {
      const safeLimit = Math.floor(text.length * STRICT_REDUCTION_FACTOR);
      this._logger.warn(
        `[mymem] Recursion depth ${depth} reached MAX_EMBED_DEPTH (${MAX_EMBED_DEPTH}), ` +
        `force-truncating ${text.length} chars → ${safeLimit} chars (strict ${STRICT_REDUCTION_FACTOR * 100}% reduction)`
      );
      if (safeLimit < 100) {
        throw new Error(
          `[mymem] Failed to embed: input too large for model context after ${MAX_EMBED_DEPTH} retries`
        );
      }
      text = text.slice(0, safeLimit);
    }

    // Check cache first
    const cached = this._cache.get(text, task);
    if (cached) return cached;

    try {
      const payload = this.buildPayload(text, task);
      let response = await this.embedWithRetry(payload, signal);
      if (!Array.isArray(response?.data) && isLoopbackBaseURL(this._baseURL)) {
        response = await this.embedWithNativeFetch(payload, signal);
      }
      const embedding = response.data[0]?.embedding as number[] | undefined;
      if (!embedding) {
        throw new Error("No embedding returned from provider");
      }

      this.validateEmbedding(embedding);
      this._cache.set(text, task, embedding);
      return embedding;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk) {
        try {
          this._logger.info(`Document exceeded context limit (${errorMsg}), attempting chunking...`);
          const chunkResult = smartChunk(text, this._model);

          if (chunkResult.chunks.length === 0) {
            throw new Error(`Failed to chunk document: ${errorMsg}`);
          }

          // FR-03: Single chunk output detection — if smartChunk produced only
          // one chunk that is nearly the same size as the original text, chunking
          // did not actually reduce the problem. Force-truncate with STRICT
          // reduction to guarantee progress.
          if (
            chunkResult.chunks.length === 1 &&
            chunkResult.chunks[0].length > text.length * 0.9
          ) {
            // Use strict reduction factor to guarantee each retry makes progress
            const safeLimit = Math.floor(text.length * STRICT_REDUCTION_FACTOR);
            this._logger.warn(
              `[mymem] smartChunk produced 1 chunk (${chunkResult.chunks[0].length} chars) ≈ original (${text.length} chars). ` +
              `Force-truncating to ${safeLimit} chars (strict ${STRICT_REDUCTION_FACTOR * 100}% reduction) to avoid infinite recursion.`
            );
            if (safeLimit < 100) {
              throw new Error(
                `[mymem] Failed to embed: chunking couldn't reduce input size enough for model context`
              );
            }
            const truncated = text.slice(0, safeLimit);
            return this.embedSingle(truncated, task, depth + 1, signal);
          }

          // Embed all chunks in parallel
          this._logger.info(`Split document into ${chunkResult.chunkCount} chunks for embedding`);
          const chunkEmbeddings = await Promise.all(
            chunkResult.chunks.map(async (chunk, idx) => {
              try {
                const embedding = await this.embedSingle(chunk, task, depth + 1, signal);
                return { embedding };
              } catch (chunkError) {
                this._logger.warn(`Failed to embed chunk ${idx}:`, chunkError);
                throw chunkError;
              }
            })
          );

          // Compute average embedding across chunks
          const avgEmbedding = chunkEmbeddings.reduce(
            (sum, { embedding }) => {
              for (let i = 0; i < embedding.length; i++) {
                sum[i] += embedding[i];
              }
              return sum;
            },
            new Array(this.dimensions).fill(0)
          );

          const finalEmbedding = avgEmbedding.map(v => v / chunkEmbeddings.length);

          // Cache the result for the original text (using its hash)
          this._cache.set(text, task, finalEmbedding);
          this._logger.info(`Successfully embedded long document as ${chunkEmbeddings.length} averaged chunks`);

          return finalEmbedding;
        } catch (chunkError) {
          // Preserve and surface the more specific chunkError
          this._logger.warn(`Chunking failed:`, chunkError);
          throw chunkError;
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "single",
      });
      throw new Error(friendly, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async embedMany(texts: string[], task?: string, signal?: AbortSignal): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Check cache first — only send uncached texts to the API
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!text || text.trim().length === 0) {
        results[i] = [];
        continue;
      }
      const cached = this._cache.get(text, task);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    if (uncachedTexts.length === 0) {
      return results;
    }

    try {
      const response = await this.embedWithRetry(
        this.buildPayload(uncachedTexts, task),
        signal,
      );

      if (!Array.isArray(response?.data) || response.data.length !== uncachedTexts.length) {
        throw new Error(
          `Embedding provider returned invalid response for ${uncachedTexts.length} inputs (unexpected result count)`
        );
      }

      // Fill in embeddings for uncached texts
      response.data.forEach((item: { embedding?: unknown }, idx: number) => {
        const originalIndex = uncachedIndices[idx];
        const embedding = item.embedding as number[];

        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error(
            `Embedding provider returned invalid response for ${uncachedTexts.length} inputs`
          );
        }

        this.validateEmbedding(embedding);
        this._cache.set(uncachedTexts[idx], task, embedding);
        results[originalIndex] = embedding;
      });

      // Fill empty arrays for remaining texts
      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) {
          results[i] = [];
        }
      }

      return results;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking each text
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk) {
        try {
          this._logger.info(`Batch embedding failed with context error, attempting chunking...`);

          const chunkResults = await Promise.all(
            uncachedTexts.map(async (text, idx) => {
              const chunkResult = smartChunk(text, this._model);
              if (chunkResult.chunks.length === 0) {
                throw new Error("Chunker produced no chunks");
              }

              // Embed all chunks in parallel, then average.
              const embeddings = await Promise.all(
                chunkResult.chunks.map((chunk) => this.embedSingle(chunk, task, 0, signal))
              );

              const avgEmbedding = embeddings.reduce(
                (sum, emb) => {
                  for (let i = 0; i < emb.length; i++) {
                    sum[i] += emb[i];
                  }
                  return sum;
                },
                new Array(this.dimensions).fill(0)
              );

              const finalEmbedding = avgEmbedding.map((v) => v / embeddings.length);

              // Cache the averaged embedding for the original (long) text.
              this._cache.set(text, task, finalEmbedding);

              return { embedding: finalEmbedding, index: uncachedIndices[idx] };
            })
          );

          this._logger.info(`Successfully chunked and embedded ${chunkResults.length} long documents`);

          // Fill chunked results into the main results array
          chunkResults.forEach(({ embedding, index }) => {
            if (embedding.length > 0) {
              this.validateEmbedding(embedding);
              results[index] = embedding;
            } else {
              results[index] = [];
            }
          });

          // Fill empty arrays for invalid texts
          for (let i = 0; i < texts.length; i++) {
            if (!results[i]) {
              results[i] = [];
            }
          }

          return results;
        } catch (chunkError) {
          const friendly = formatEmbeddingProviderError(error, {
            baseURL: this._baseURL,
            model: this._model,
            mode: "batch",
          });
          throw new Error(`Failed to embed documents after chunking attempt: ${friendly}`, {
            cause: error instanceof Error ? error : undefined,
          });
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "batch",
      });
      throw new Error(friendly, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  get model(): string {
    return this._model;
  }

  // Test connection and validate configuration
  async test(signal?: AbortSignal): Promise<{ success: boolean; error?: string; dimensions?: number }> {
    try {
      const testEmbedding = await this.embedPassage("test", signal);
      return {
        success: true,
        dimensions: testEmbedding.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Warm up the embedding provider with a dummy request.
   * Call during plugin init to pre-establish connections and avoid cold-start
   * latency on the first real query.
   */
  async warmup(): Promise<void> {
    try {
      await this.embedQuery("warmup");
    } catch {
      // Ignore warmup errors — the provider may not be ready yet.
      // The actual query will retry with proper error handling.
    }
  }

  get cacheStats() {
    return {
      ...this._cache.stats,
      keyCount: this.clients.length,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}
