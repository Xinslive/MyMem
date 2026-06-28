/**
 * Auto-Backup System
 *
 * Extracted from index.ts. Daily JSONL export of all memories.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryStore } from "./store.js";
import { join } from "node:path";
import { mkdir, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface AutoBackupParams {
  api: OpenClawPluginApi;
  store: MemoryStore;
  resolvedDbPath: string;
}

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_BACKUPS = 7;

export function createAutoBackup(params: AutoBackupParams) {
  const { api, store, resolvedDbPath } = params;
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  let initialBackupTimer: ReturnType<typeof setTimeout> | null = null;
  const activeBackups = new Set<Promise<void>>();

  async function runBackupOnce() {
    try {
      if (!resolvedDbPath) {
        api.logger.debug("mymem: backup skipped (no dbPath)");
        return;
      }
      const backupDir = api.resolvePath(join(resolvedDbPath, "..", "backups"));
      if (!backupDir) {
        api.logger.debug("mymem: backup skipped (resolvePath returned empty)");
        return;
      }
      await mkdir(backupDir, { recursive: true });

      const allMemories = await store.list(undefined, undefined, 10000, 0);
      if (allMemories.length === 0) return;

      const dateStr = new Date().toISOString().split("T")[0];
      const backupFile = join(backupDir, `memory-backup-${dateStr}.jsonl`);

      const lines = allMemories.map((m) =>
        JSON.stringify({
          id: m.id, text: m.text, category: m.category, scope: m.scope,
          importance: m.importance, timestamp: m.timestamp, metadata: m.metadata,
        }),
      );

      // Audit #15: atomic write with tmpFile + rename + mode 0o600 to protect
      // the backup from corruption on kill -9 and from other local processes.
      const tmpPath = `${backupFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmpPath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, backupFile);

      // Keep only last N backups
      const files = (await readdir(backupDir))
        .filter((f) => f.startsWith("memory-backup-") && f.endsWith(".jsonl"))
        .sort();
      if (files.length > MAX_BACKUPS) {
        for (const old of files.slice(0, files.length - MAX_BACKUPS)) {
          await unlink(join(backupDir, old)).catch(() => {});
        }
      }

      api.logger.info(`mymem: backup completed (${allMemories.length} entries → ${backupFile})`);
    } catch (err) {
      api.logger.warn(`mymem: backup failed: ${String(err)}`);
    }
  }

  async function runBackup() {
    const task = runBackupOnce();
    activeBackups.add(task);
    try {
      await task;
    } finally {
      activeBackups.delete(task);
    }
  }

  async function drainActiveBackups() {
    while (activeBackups.size > 0) {
      await Promise.allSettled([...activeBackups]);
    }
  }

  return {
    runBackup,
    start() {
      initialBackupTimer = setTimeout(() => {
        initialBackupTimer = null;
        void runBackup();
      }, 60_000); // 1 min after start
      backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);
    },
    stop() {
      if (initialBackupTimer) {
        clearTimeout(initialBackupTimer);
        initialBackupTimer = null;
      }
      if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
      }
      return drainActiveBackups();
    },
  };
}
