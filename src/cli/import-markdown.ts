import type { Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { Embedder } from "../embedder.js";
import type { MemoryStore } from "../store.js";
import {
  buildSmartMetadata,
  stringifySmartMetadata,
} from "../smart-metadata.js";
import { clampInt } from "../utils.js";
import { sanitizeMemoryWriteText } from "../memory-write-sanitizer.js";

function redactedPreview(text: string, maxChars: number): string {
  return sanitizeMemoryWriteText(text).slice(0, maxChars);
}

export async function runImportMarkdown(
  ctx: { embedder?: Embedder; store: MemoryStore },
  workspaceGlob: string | undefined,
  options: {
    dryRun?: boolean;
    scope?: string;
    openclawHome?: string;
    dedup?: boolean;
    minTextLength?: string;
    importance?: string;
  },
): Promise<{ imported: number; skipped: number; foundFiles: number }> {
  const openclawHome = options.openclawHome
    ? path.resolve(options.openclawHome)
    : path.join(homedir(), ".openclaw");

  const workspaceDir = path.join(openclawHome, "workspace");
  let imported = 0;
  let skipped = 0;
  let foundFiles = 0;

  if (!ctx.embedder) {
    throw new Error(
      "import-markdown requires an embedder. Use via plugin CLI or ensure embedder is configured.",
    );
  }

  let workspaceScope = "";
  try {
    const configPath = path.join(openclawHome, "openclaw.json");
    const configContent = await readFile(configPath, "utf8");
    const config = JSON5.parse(configContent);
    const agentsList: Array<{ id?: string; workspace?: string }> = config?.agents?.list ?? [];
    const matchedAgents = agentsList.filter((a) => {
      if (!a.workspace) return false;
      const normalized = path.normalize(a.workspace);
      return normalized.startsWith(workspaceDir + path.sep);
    });
    if (matchedAgents.length === 1 && matchedAgents[0]?.id) {
      workspaceScope = matchedAgents[0].id;
    }
  } catch {
    // Use the default global scope when OpenClaw config is absent or unreadable.
  }

  const fsPromises = await import("node:fs/promises");

  let workspaceEntries: Dirent[];
  try {
    workspaceEntries = await fsPromises.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    throw new Error(`Failed to read workspace directory: ${workspaceDir}`);
  }

  const mdFiles: Array<{ filePath: string; scope: string }> = [];

  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) continue;
    if (workspaceGlob && !entry.name.includes(workspaceGlob)) continue;

    const workspacePath = path.join(workspaceDir, entry.name);

    const memoryMd = path.join(workspacePath, "MEMORY.md");
    try {
      await fsPromises.stat(memoryMd);
      mdFiles.push({ filePath: memoryMd, scope: entry.name });
    } catch {
      // Not every workspace has MEMORY.md.
    }

    const memoryDir = path.join(workspacePath, "memory");
    try {
      const stats = await fsPromises.stat(memoryDir);
      if (stats.isDirectory()) {
        const files = await fsPromises.readdir(memoryDir, { withFileTypes: true });
        for (const f of files) {
          if (f.isFile() && f.name.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f.name)) {
            mdFiles.push({ filePath: path.join(memoryDir, f.name), scope: entry.name });
          }
        }
      }
    } catch {
      // Not every workspace has a memory/ directory.
    }
  }

  async function scanAgentMd(
    agentPath: string,
    agentId: string,
    mdFiles: Array<{ filePath: string; scope: string }>,
    fsP: typeof import("node:fs/promises"),
  ): Promise<void> {
    const agentMemoryMd = path.join(agentPath, "MEMORY.md");
    try {
      await fsP.stat(agentMemoryMd);
      mdFiles.push({ filePath: agentMemoryMd, scope: agentId });
    } catch {
      // Not every agent workspace has MEMORY.md.
    }

    const agentMemoryDir = path.join(agentPath, "memory");
    try {
      const stats = await fsP.stat(agentMemoryDir);
      if (stats.isDirectory()) {
        const files = await fsP.readdir(agentMemoryDir);
        for (const f of files) {
          if (f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f)) {
            mdFiles.push({ filePath: path.join(agentMemoryDir, f), scope: agentId });
          }
        }
      }
    } catch {
      // Not every agent workspace has a memory/ directory.
    }
  }

  const agentsDir = path.join(workspaceDir, "agents");
  try {
    const agentEntries = await fsPromises.readdir(agentsDir, { withFileTypes: true });
    if (workspaceGlob) {
      const matchedAgent = agentEntries.find(e => e.isDirectory() && e.name === workspaceGlob);
      if (matchedAgent) {
        const agentPath = path.join(agentsDir, matchedAgent.name);
        await scanAgentMd(agentPath, matchedAgent.name, mdFiles, fsPromises);
      }
    } else {
      for (const agentEntry of agentEntries) {
        if (!agentEntry.isDirectory()) continue;
        const agentPath = path.join(agentsDir, agentEntry.name);
        await scanAgentMd(agentPath, agentEntry.name, mdFiles, fsPromises);
      }
    }
  } catch {
    // No agents/ directory.
  }

  if (!workspaceGlob) {
    const flatMemoryDir = path.join(workspaceDir, "memory");
    try {
      const stats = await fsPromises.stat(flatMemoryDir);
      if (stats.isDirectory()) {
        const files = await fsPromises.readdir(flatMemoryDir, { withFileTypes: true });
        for (const f of files) {
          if (f.isFile() && f.name.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f.name)) {
            mdFiles.push({ filePath: path.join(flatMemoryDir, f.name), scope: workspaceScope || "global" });
          }
        }
      }
    } catch {
      // Flat memory directory is optional.
    }
  }

  if (mdFiles.length === 0) {
    return { imported: 0, skipped: 0, foundFiles: 0 };
  }

  const minTextLength = clampInt(parseInt(options.minTextLength ?? "5", 10), 1, 10_000);
  const importanceDefault = Number.isFinite(parseFloat(options.importance ?? "0.7"))
    ? Math.max(0, Math.min(1, parseFloat(options.importance ?? "0.7")))
    : 0.7;
  const dedupEnabled = !!options.dedup;

  for (const { filePath, scope: discoveredScope } of mdFiles) {
    foundFiles++;
    let content = await fsPromises.readFile(filePath, "utf-8");
    content = content.replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (!/^[-*+]\s/.test(line)) continue;
      const text = sanitizeMemoryWriteText(line.slice(2).trim());
      if (text.length < minTextLength) {
        skipped++;
        continue;
      }

      const effectiveScope = options.scope || discoveredScope;

      if (dedupEnabled) {
        try {
          const existing = await ctx.store.bm25Search(text, 5, [effectiveScope]);
          if (existing.length > 0 && existing[0].entry.text === text) {
            skipped++;
            if (!options.dryRun) {
              console.log(`  [skip] already imported: ${redactedPreview(text, 60)}${text.length > 60 ? "..." : ""}`);
            }
            continue;
          }
        } catch (err) {
          console.warn(`  [import-markdown] dedup check failed (${err}), proceeding with import: ${redactedPreview(text, 60)}...`);
        }
      }

      if (options.dryRun) {
        console.log(`  [dry-run] would import: ${redactedPreview(text, 80)}${text.length > 80 ? "..." : ""}`);
        imported++;
        continue;
      }

      try {
        const vector = await ctx.embedder.embedPassage(text);
        await ctx.store.store({
          text,
          vector,
          importance: importanceDefault,
          category: "patterns",
          scope: effectiveScope,
          metadata: stringifySmartMetadata(
            buildSmartMetadata(
              { text, category: "patterns", importance: importanceDefault },
              {
                memory_category: "patterns",
                source: "manual",
                state: "confirmed",
                importedFrom: filePath,
                sourceScope: discoveredScope,
              },
            ),
          ),
        });
        imported++;
      } catch (err) {
        console.warn(`  Failed to import: ${redactedPreview(text, 60)}... - ${err}`);
        skipped++;
      }
    }
  }

  if (options.dryRun) {
    console.log(`\nDRY RUN - found ${foundFiles} files, ${imported} entries would be imported, ${skipped} skipped${dedupEnabled ? " [dedup enabled]" : ""}`);
  } else {
    console.log(`\nImport complete: ${imported} imported, ${skipped} skipped (scanned ${foundFiles} files)${dedupEnabled ? " [dedup enabled]" : ""}`);
  }
  return { imported, skipped, foundFiles };
}
