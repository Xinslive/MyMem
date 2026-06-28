/**
 * File Utilities
 *
 * Helper functions for file system operations.
 */

import { stat, readdir, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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

/**
 * Atomically writes a small text file by writing a sibling temp file
 * first, then renaming it into place.
 */
export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort cleanup; preserve the original write/rename error.
    }
    throw err;
  }
}

/**
 * Atomically writes a small JSON state file by writing a sibling temp file
 * first, then renaming it into place.
 */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, JSON.stringify(value));
}
