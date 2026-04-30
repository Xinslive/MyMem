import { detectEmbeddingProviderProfile, getProviderLabel } from "./embedding-provider.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (err.error && typeof err.error === "object") {
    const nested = err.error as Record<string, unknown>;
    if (typeof nested.status === "number") return nested.status;
    if (typeof nested.statusCode === "number") return nested.statusCode;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  if (typeof err.code === "string") return err.code;
  const nested = err.error as Record<string, unknown> | undefined;
  if (nested && typeof nested === "object" && typeof nested.code === "string") {
    return nested.code;
  }
  return undefined;
}

function isAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;

  const code = getErrorCode(error);
  if (code && /invalid.*key|auth|forbidden|unauthorized/i.test(code)) return true;

  const msg = getErrorMessage(error);
  return /\b401\b|\b403\b|invalid api key|api key expired|expired api key|forbidden|unauthorized|authentication failed|access denied/i.test(msg);
}

function isNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(code)) {
    return true;
  }

  const msg = getErrorMessage(error);
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|network error|socket hang up|connection refused|getaddrinfo/i.test(msg);
}

/** Check if an error is a request abort (timeout or client-side cancellation). */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const msg = getErrorMessage(error);
  return /request was aborted|the operation was aborted|aborted|aborterror/i.test(msg)
    && !/authentication|auth|api key|forbidden/i.test(msg);
}

export { getErrorMessage, getErrorStatus, getErrorCode, isAuthError, isNetworkError, isAbortError };

export function formatEmbeddingProviderError(
  error: unknown,
  opts: { baseURL?: string; model: string; mode?: "single" | "batch" },
): string {
  const raw = getErrorMessage(error).trim();
  if (
    raw.startsWith("Embedding provider authentication failed") ||
    raw.startsWith("Embedding provider unreachable") ||
    raw.startsWith("Failed to generate embedding from ") ||
    raw.startsWith("Failed to generate batch embeddings from ")
  ) {
    return raw;
  }

  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const provider = getProviderLabel(opts.baseURL, opts.model);
  const detail = raw.length > 0 ? raw : "unknown error";
  const suffix = [status, code].filter(Boolean).join(" ");
  const detailText = suffix ? `${suffix}: ${detail}` : detail;
  const genericPrefix =
    opts.mode === "batch"
      ? `Failed to generate batch embeddings from ${provider}: `
      : `Failed to generate embedding from ${provider}: `;

  if (isAuthError(error)) {
    let hint = `Check embedding.apiKey and endpoint for ${provider}.`;
    // Use profile rather than provider label so Jina-specific hint also fires
    // when model is jina-* but baseURL is a proxy (not api.jina.ai).
    const profile = detectEmbeddingProviderProfile(opts.baseURL, opts.model);
    if (profile === "jina") {
      hint +=
        " If your Jina key expired or lost access, replace the key or switch to a local OpenAI-compatible endpoint such as Ollama (for example baseURL http://127.0.0.1:11434/v1, with a matching model and embedding.dimensions).";
    } else if (provider === "Ollama") {
      hint +=
        " Ollama usually works with a dummy apiKey; verify the local server is running, the model is pulled, and embedding.dimensions matches the model output.";
    }
    return `Embedding provider authentication failed (${detailText}). ${hint}`;
  }

  if (isNetworkError(error)) {
    let hint = `Verify the endpoint is reachable`;
    if (opts.baseURL) {
      hint += ` at ${opts.baseURL}`;
    }
    hint += ` and that model \"${opts.model}\" is available.`;
    return `Embedding provider unreachable (${detailText}). ${hint}`;
  }

  return `${genericPrefix}${detailText}`;
}
