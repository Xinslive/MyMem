import {
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";

function errnoDetails(error: unknown): { code: string; message: string } {
  const err = error as NodeJS.ErrnoException;
  return {
    code: typeof err.code === "string" ? err.code : "",
    message: typeof err.message === "string" ? err.message : String(error),
  };
}

/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;

  // Resolve symlinks (including dangling symlinks)
  try {
    const stats = lstatSync(dbPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(dbPath);
      } catch (err) {
        const details = errnoDetails(err);
        throw new Error(
          `dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
          `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
          `  Details: ${details.code} ${details.message}`,
        );
      }
    }
  } catch (err) {
    const details = errnoDetails(err);
    // Missing path is OK (it will be created below)
    if (details.code === "ENOENT") {
      // no-op
    } else if (
      details.message.includes("symlink whose target does not exist")
    ) {
      throw err;
    } else {
      // Other lstat failures ??continue with original path
    }
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err) {
      const details = errnoDetails(err);
      throw new Error(
        `Failed to create dbPath directory "${resolvedPath}".\n` +
        `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
        `       or create it manually: mkdir -p "${resolvedPath}"\n` +
        `  Details: ${details.code} ${details.message}`,
      );
    }
  }

  // Check write permissions
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err) {
    const details = errnoDetails(err);
    throw new Error(
      `dbPath directory "${resolvedPath}" is not writable.\n` +
      `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
      `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
      `  Details: ${details.code} ${details.message}`,
    );
  }

  return resolvedPath;
}
