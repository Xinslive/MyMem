/**
 * Path Utilities
 *
 * Helper functions for resolving default paths and workspace directories.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the default database path for memory storage.
 */
export function getDefaultDbPath(): string {
  return join(homedir(), ".openclaw", "memory", "mymem");
}

/**
 * Returns the default workspace directory.
 */
export function getDefaultWorkspaceDir(): string {
  return join(homedir(), ".openclaw", "workspace");
}

/**
 * Returns the default md-mirror directory.
 */
export function getDefaultMdMirrorDir(): string {
  return join(homedir(), ".openclaw", "memory", "md-mirror");
}

/**
 * Resolves workspace directory from context, with fallback to default.
 */
export function resolveWorkspaceDirFromContext(
  context: Record<string, unknown> | undefined,
): string {
  const runtimePath =
    typeof context?.workspaceDir === "string"
      ? (context.workspaceDir as string).trim()
      : "";
  return runtimePath || getDefaultWorkspaceDir();
}
