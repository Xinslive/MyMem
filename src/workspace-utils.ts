/**
 * Workspace Utilities
 *
 * Helper functions for workspace resolution and md-mirror writing.
 */

import { readdir, mkdir, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { sortFileNamesByMtimeDesc } from "./file-utils.js";
import { getDefaultMdMirrorDir } from "./path-utils.js";
import { resolveRejectedAuditFilePath } from "./admission-control.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, AgentWorkspaceMap } from "./plugin-types.js";
import type { AdmissionRejectionAuditEntry } from "./admission-control.js";

/**
 * Finds the previous session file in a directory.
 */
export async function findPreviousSessionFile(
  sessionsDir: string,
  currentSessionFile?: string,
  sessionId?: string,
  stripResetSuffix?: (name: string) => string,
): Promise<string | undefined> {
  try {
    const files = await readdir(sessionsDir);
    const fileSet = new Set(files);

    // Try recovering the non-reset base file
    const stripFn = stripResetSuffix || ((n: string) => n.replace(/\.reset\.\d+(\.\w+)?$/, ""));
    const baseFromReset = currentSessionFile
      ? stripFn(basename(currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset))
      return join(sessionsDir, baseFromReset);

    // Try canonical session ID file
    const trimmedId = sessionId?.trim();
    if (trimmedId) {
      const canonicalFile = `${trimmedId}.jsonl`;
      if (fileSet.has(canonicalFile)) return join(sessionsDir, canonicalFile);

      // Try topic variants
      const topicVariants = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter(
          (name) =>
            name.startsWith(`${trimmedId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
      );
      if (topicVariants.length > 0) return join(sessionsDir, topicVariants[0]);
    }

    // Fallback to most recent non-reset JSONL
    if (currentSessionFile) {
      const nonReset = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      );
      if (nonReset.length > 0) return join(sessionsDir, nonReset[0]);
    }
  } catch { }
}

/**
 * Resolves agent workspace map from API config or openclaw.json.
 */
export function resolveAgentWorkspaceMap(api: OpenClawPluginApi): AgentWorkspaceMap {
  const map: AgentWorkspaceMap = {};

  // Try api.config first (runtime config)
  const apiExtended = api as unknown as { config?: { agents?: { list?: Array<{ id?: string; workspace?: string }> } } };
  const agents = Array.isArray(apiExtended.config?.agents?.list)
    ? apiExtended.config.agents.list
    : [];

  for (const agent of agents) {
    if (agent?.id && typeof agent.workspace === "string") {
      map[String(agent.id)] = agent.workspace;
    }
  }

  // Fallback: read from openclaw.json (respect OPENCLAW_HOME if set)
  if (Object.keys(map).length === 0) {
    try {
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const configPath = join(openclawHome, "openclaw.json");
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      const list = parsed?.agents?.list;
      if (Array.isArray(list)) {
        for (const agent of list) {
          if (agent?.id && typeof agent.workspace === "string") {
            map[String(agent.id)] = agent.workspace;
          }
        }
      }
    } catch {
      /* silent */
    }
  }

  return map;
}

export interface MdMirrorEntry {
  text: string;
  category: string;
  scope: string;
  timestamp?: number;
}

export interface MdMirrorMeta {
  agentId?: string;
  source?: string;
}

export type MdMirrorWriter = (entry: MdMirrorEntry, meta?: MdMirrorMeta) => Promise<void>;

/**
 * Creates an md-mirror writer function.
 */
export function createMdMirrorWriter(
  api: OpenClawPluginApi,
  config: PluginConfig,
): MdMirrorWriter | null {
  if (config.mdMirror?.enabled !== true) return null;

  const fallbackDir = api.resolvePath(
    config.mdMirror.dir ?? getDefaultMdMirrorDir(),
  );
  const workspaceMap = resolveAgentWorkspaceMap(api);

  if (Object.keys(workspaceMap).length > 0) {
    api.logger.info(
      `mdMirror: resolved ${Object.keys(workspaceMap).length} agent workspace(s)`,
    );
  } else {
    api.logger.warn(
      `mdMirror: no agent workspaces found, writes will use fallback dir: ${fallbackDir}`,
    );
  }

  return async (entry, meta) => {
    try {
      const ts = new Date(entry.timestamp || Date.now());
      const dateStr = ts.toISOString().split("T")[0];

      let mirrorDir = fallbackDir;
      if (meta?.agentId && workspaceMap[meta.agentId]) {
        mirrorDir = join(workspaceMap[meta.agentId], "memory");
      }

      const filePath = join(mirrorDir, `${dateStr}.md`);
      const agentLabel = meta?.agentId ? ` agent=${meta.agentId}` : "";
      const sourceLabel = meta?.source ? ` source=${meta.source}` : "";
      const safeText = entry.text.replace(/\n/g, " ").slice(0, 500);
      const line = `- ${ts.toISOString()} [${entry.category}:${entry.scope}]${agentLabel}${sourceLabel} ${safeText}\n`;

      await mkdir(mirrorDir, { recursive: true });
      await appendFile(filePath, line, "utf8");
    } catch (err) {
      api.logger.warn(`mdMirror: write failed: ${String(err)}`);
    }
  };
}

/**
 * Creates an admission rejection audit writer function.
 */
export function createAdmissionRejectionAuditWriter(
  config: PluginConfig,
  resolvedDbPath: string,
  api: OpenClawPluginApi,
): ((entry: AdmissionRejectionAuditEntry) => Promise<void>) | null {
  if (
    config.admissionControl?.enabled !== true ||
    config.admissionControl.persistRejectedAudits !== true
  ) {
    return null;
  }

  const filePath = api.resolvePath(
    resolveRejectedAuditFilePath(resolvedDbPath, config.admissionControl),
  );

  return async (entry: AdmissionRejectionAuditEntry) => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      api.logger.warn(`mymem: admission rejection audit write failed: ${String(err)}`);
    }
  };
}
