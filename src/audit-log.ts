/**
 * Audit Log — append-only JSONL log for memory mutations (audit #30).
 *
 * Writes to `<dbPath>/audit.jsonl`. Each entry captures the operation, the
 * affected memory ID, the source agent (when available), and a timestamp.
 * Read access is intentionally NOT logged (PII concern — see #30 in
 * docs/audit-2026-06-28.md).
 *
 * The log is append-only and never rotated by the plugin itself; users may
 * compress or archive it independently. File mode is 0o600 to match the
 * dashboard-token and OAuth-token security posture.
 *
 * Callers should treat the audit log as best-effort: a failure to write must
 * never prevent the primary mutation from succeeding.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface AuditEntry {
  /** ISO-8601 timestamp */
  at: string;
  /** Operation: "store" | "update" | "delete" | "import" | "reembed" */
  op: string;
  /** Memory ID affected (first 8 chars in log for brevity) */
  id: string;
  /** Agent or session that triggered the op (if known) */
  agent?: string;
  /** Free-form detail (e.g. category, scope, or reason) */
  detail?: string;
}

export class AuditLogger {
  private filePath: string | null = null;
  private initPromise: Promise<void> | null = null;
  private enabled = false;

  /**
   * @param dbPath Path to the LanceDB store directory. The audit file is
   *   written to `<dbPath>/audit.jsonl`.
   */
  constructor(private readonly dbPath: string) {}

  /** Enable logging and ensure the parent directory exists. */
  async enable(): Promise<void> {
    if (this.enabled) return;
    this.filePath = join(this.dbPath, "audit.jsonl");
    this.initPromise = mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined).catch(() => undefined);
    await this.initPromise;
    this.enabled = true;
  }

  /** Is this logger ready to write? */
  get isEnabled(): boolean {
    return this.enabled && this.filePath !== null;
  }

  /**
   * Append an entry to the audit log. Errors are swallowed — the primary
   * mutation must succeed regardless of audit-log health.
   */
  log(entry: AuditEntry): void {
    if (!this.enabled || !this.filePath) return;
    const line = JSON.stringify(entry) + "\n";
    // Fire-and-forget: do not await; do not block the caller.
    void appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 }).catch(() => {});
  }
}
