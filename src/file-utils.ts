/**
 * File Utilities
 *
 * Helper functions for file system operations.
 */

import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Sorts file names by modification time (newest first).
 */
export async function sortFileNamesByMtimeDesc(dir: string, fileNames: string[]): Promise<string[]> {
  const candidates = await Promise.all(
    fileNames.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  return candidates
    .filter((x): x is { name: string; mtimeMs: number } => x !== null)
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
    .map((x) => x.name);
}

/**
 * Lists directory contents, returning only file/directory names.
 */
export async function listDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => e.name);
  } catch {
    return [];
  }
}
