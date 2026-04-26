/**
 * Unified Logger for mymem
 *
 * Provides a consistent logging interface that:
 * 1. Uses the OpenClaw plugin API logger when available
 * 2. Falls back to console methods for CLI/testing contexts
 * 3. Supports structured log levels (debug/info/warn/error)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Create a logger that wraps the OpenClaw plugin API logger.
 * Falls back to console methods when pluginApi is not available.
 */
export function createLogger(pluginApi?: { logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void } }): Logger {
  const api = pluginApi?.logger;

  // If we have a real API logger, wrap it
  if (api) {
    return {
      debug: (msg, ...args) => {
        const formatted = args.length > 0 ? `${msg} ${args.map(a => String(a)).join(" ")}` : msg;
        api.debug?.(formatted);
      },
      info: (msg, ...args) => {
        const formatted = args.length > 0 ? `${msg} ${args.map(a => String(a)).join(" ")}` : msg;
        api.info?.(formatted);
      },
      warn: (msg, ...args) => {
        const formatted = args.length > 0 ? `${msg} ${args.map(a => String(a)).join(" ")}` : msg;
        api.warn?.(formatted);
      },
      error: (msg, ...args) => {
        const formatted = args.length > 0 ? `${msg} ${args.map(a => String(a)).join(" ")}` : msg;
        api.error?.(formatted);
      },
    };
  }

  // Fallback to console with level prefixes
  const isDebugEnabled = process.env.DEBUG?.includes("mymem") ?? false;

  return {
    debug: (msg, ...args) => {
      if (isDebugEnabled) {
        console.debug(`[mymem] ${msg}`, ...args);
      }
    },
    info: (msg, ...args) => {
      console.log(`[mymem] ${msg}`, ...args);
    },
    warn: (msg, ...args) => {
      console.warn(`[mymem] ${msg}`, ...args);
    },
    error: (msg, ...args) => {
      console.error(`[mymem] ${msg}`, ...args);
    },
  };
}

/**
 * Null logger that discards all output. Useful for tests or when logging is disabled.
 */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Check if we're running in CLI mode (no plugin API).
 */
export function isCliMode(): boolean {
  return process.env.OPENCLAW_CLI === "1";
}
