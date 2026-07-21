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

// ============================================================================
// Per-path write-queue serialization (2026-07-21 review P1-H)
// ============================================================================

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Serializes async work that targets a specific file path. Concurrent calls
 * with the same path are processed in submission order; calls to different
 * paths run independently. The queue self-cleans once the last action resolves
 * so process-global state stays bounded.
 *
 * Used by mdMirror and admission-rejection writers so JSONL appends from
 * concurrent store() calls or admission rejections cannot tear lines or
 * starve each other on slow disks.
 */
export async function withWriteQueue<T>(
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  let release: ((value: unknown) => void) | undefined;
  const lock = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  writeQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.(undefined);
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}

/**
 * Wait for all in-flight writes registered against the given paths to settle.
 * Used by shutdown drain to avoid losing buffered JSONL entries when the
 * process is about to exit.
 */
export async function flushWriteQueues(filePaths: string[]): Promise<void> {
  const uniquePaths = [...new Set(filePaths)];
  // Snapshot the queue entries; tail-chase so writes appended during the
  // drain still complete before this returns.
  const seen = new Set<string>();
  while (true) {
    const pending: Promise<unknown>[] = [];
    for (const filePath of uniquePaths) {
      if (seen.has(filePath)) continue;
      const entry = writeQueues.get(filePath);
      if (entry) {
        pending.push(entry);
        seen.add(filePath);
      }
    }
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
