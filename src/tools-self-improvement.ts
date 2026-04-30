/**
 * Agent Tool Definitions — Self-Improvement Tools
 * Registration functions for self_improvement_log, self_improvement_extract_skill,
 * self_improvement_review, and self_improvement_distill.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ToolContext,
  stringEnum,
  resolveWorkspaceDir,
  escapeRegExp,
  parseLearningBacklogEntries,
  buildSelfImprovementDistillPatch,
  type LearningBacklogEntry,
} from "./tools-shared.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";

export function registerSelfImprovementLogTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_log",
      label: "Self-Improvement Log",
      description: "Log structured learning/error entries into .learnings for governance and later distillation.",
      parameters: Type.Object({
        type: stringEnum(["learning", "error"]),
        summary: Type.String({ description: "One-line summary" }),
        details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
        suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
        category: Type.Optional(Type.String({ description: "learning category (correction/best_practice/knowledge_gap) when type=learning" })),
        area: Type.Optional(Type.String({ description: "frontend|backend|infra|tests|docs|config or custom area" })),
        priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
      }),
      async execute(_toolCallId, params) {
        const {
          type,
          summary,
          details = "",
          suggestedAction = "",
          category = "best_practice",
          area = "config",
          priority = "medium",
        } = params as {
          type: "learning" | "error";
          summary: string;
          details?: string;
          suggestedAction?: string;
          category?: string;
          area?: string;
          priority?: string;
        };
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          const { id: entryId, filePath } = await appendSelfImprovementEntry({
            baseDir: workspaceDir,
            type,
            summary,
            details,
            suggestedAction,
            category,
            area,
            priority,
            source: "mymem/self_improvement_log",
          });
          const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";

          return {
            content: [{ type: "text", text: `Logged ${type} entry ${entryId} to .learnings/${fileName}` }],
            details: { action: "logged", type, id: entryId, filePath },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_log_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_log" }
  );
}

export function registerSelfImprovementExtractSkillTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_extract_skill",
      label: "Extract Skill From Learning",
      description: "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
      parameters: Type.Object({
        learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001" }),
        skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
        sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md"])),
        outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
      }),
      async execute(_toolCallId, params) {
        const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params as {
          learningId: string;
          skillName: string;
          sourceFile?: "LEARNINGS.md" | "ERRORS.md";
          outputDir?: string;
        };
        try {
          if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
            return {
              content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
              details: { error: "invalid_learning_id" },
            };
          }
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
            return {
              content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
              details: { error: "invalid_skill_name" },
            };
          }

          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const learningsPath = join(workspaceDir, ".learnings", sourceFile);
          const learningBody = await readFile(learningsPath, "utf-8");
          const escapedLearningId = escapeRegExp(learningId.trim());
          const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
          const match = learningBody.match(entryRegex);
          if (!match) {
            return {
              content: [{ type: "text", text: `Learning entry ${learningId} not found in .learnings/${sourceFile}` }],
              details: { error: "learning_not_found", learningId, sourceFile },
            };
          }

          const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
          const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
          const safeOutputDir = outputDir
            .replace(/\\/g, "/")
            .split("/")
            .filter((segment) => segment && segment !== "." && segment !== "..")
            .join("/");
          const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
          await mkdir(skillDir, { recursive: true });
          const skillPath = join(skillDir, "SKILL.md");
          const skillTitle = skillName
            .split("-")
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(" ");
          const skillContent = [
            "---",
            `name: ${skillName}`,
            `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
            "---",
            "",
            `# ${skillTitle}`,
            "",
            "## Why",
            summary,
            "",
            "## When To Use",
            "- [TODO] Define trigger conditions",
            "",
            "## Steps",
            "1. [TODO] Add repeatable workflow steps",
            "2. [TODO] Add verification steps",
            "",
            "## Source Learning",
            `- Learning ID: ${learningId}`,
            `- Source File: .learnings/${sourceFile}`,
            "",
          ].join("\n");
          await writeFile(skillPath, skillContent, "utf-8");

          const promotedMarker = `**Status**: promoted_to_skill`;
          const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
          let updatedEntry = match[0];
          updatedEntry = updatedEntry.includes("**Status**:")
            ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
            : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
          if (!updatedEntry.includes("Skill-Path:")) {
            updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
          }
          const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
          await writeFile(learningsPath, updatedLearningBody, "utf-8");

          return {
            content: [{ type: "text", text: `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.` }],
            details: {
              action: "skill_extracted",
              learningId,
              sourceFile,
              skillPath: `${safeOutputDir || "skills"}/${skillName}/SKILL.md`,
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to extract skill: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_extract_skill_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_extract_skill" }
  );
}

export function registerSelfImprovementReviewTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_review",
      label: "Self-Improvement Review",
      description: "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
      parameters: Type.Object({}),
      async execute() {
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const learningsDir = join(workspaceDir, ".learnings");
          const files = ["LEARNINGS.md", "ERRORS.md"] as const;
          const stats = { pending: 0, high: 0, promoted: 0, total: 0 };

          for (const f of files) {
            const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
            stats.total += (content.match(/^## \[/gm) || []).length;
            stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
            stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
            stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
          }

          const text = [
            "Self-Improvement Governance Snapshot:",
            `- Total entries: ${stats.total}`,
            `- Pending: ${stats.pending}`,
            `- High/Critical: ${stats.high}`,
            `- Promoted: ${stats.promoted}`,
            "",
            "Human review required before promoting backlog into long-term rules.",
            "Use self_improvement_distill with apply=false first, review the patch, then rerun with apply=true only after approval.",
            "",
            "Recommended loop:",
            "1) Resolve high-priority pending entries",
            "2) Generate a distill proposal and ask for human approval",
            "3) Apply approved rules to AGENTS.md / SOUL.md / TOOLS.md",
            "4) Extract repeatable patterns as skills",
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: { action: "review", stats },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to review self-improvement backlog: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_review_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_review" }
  );
}

export function registerSelfImprovementDistillTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_distill",
      label: "Distill Self-Improvement Rules",
      description: "Distill pending .learnings backlog into candidate long-term rules. Safe by default: returns a patch proposal unless apply=true.",
      parameters: Type.Object({
        targetFile: Type.Optional(stringEnum(["AGENTS.md", "SOUL.md", "TOOLS.md"])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max pending/high-priority entries to distill" })),
        minPriority: Type.Optional(stringEnum(["low", "medium", "high", "critical"])),
        includeErrors: Type.Optional(Type.Boolean({ description: "Include ERRORS.md entries as prevention rules" })),
        apply: Type.Optional(Type.Boolean({ description: "When true, append the distilled rules to targetFile and mark entries promoted. Default false." })),
      }),
      async execute(_toolCallId, params) {
        const {
          targetFile = "AGENTS.md",
          limit = 10,
          minPriority = "medium",
          includeErrors = true,
          apply = false,
        } = params as {
          targetFile?: "AGENTS.md" | "SOUL.md" | "TOOLS.md";
          limit?: number;
          minPriority?: "low" | "medium" | "high" | "critical";
          includeErrors?: boolean;
          apply?: boolean;
        };

        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const learningsDir = join(workspaceDir, ".learnings");
          const files: Array<"LEARNINGS.md" | "ERRORS.md"> = includeErrors ? ["LEARNINGS.md", "ERRORS.md"] : ["LEARNINGS.md"];
          const priorityRank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
          const minRank = priorityRank[minPriority] ?? 1;
          const entries: LearningBacklogEntry[] = [];

          for (const file of files) {
            const content = await readFile(join(learningsDir, file), "utf-8").catch(() => "");
            entries.push(...parseLearningBacklogEntries(file, content));
          }

          const candidates = entries
            .filter((entry) => {
              const status = entry.status.toLowerCase();
              const rank = priorityRank[entry.priority.toLowerCase()] ?? 1;
              return rank >= minRank && !/^promoted|resolved|rejected|done$/i.test(status);
            })
            .sort((a, b) => (priorityRank[b.priority.toLowerCase()] ?? 1) - (priorityRank[a.priority.toLowerCase()] ?? 1))
            .slice(0, Math.max(1, Math.min(50, Math.floor(limit || 10))));

          if (candidates.length === 0) {
            return {
              content: [{ type: "text", text: "No pending self-improvement entries matched the distillation filters." }],
              details: { action: "distill", candidates: 0, applied: false },
            };
          }

          const patch = buildSelfImprovementDistillPatch(candidates, targetFile);
          if (!apply) {
            return {
              content: [{ type: "text", text: [
                `Self-improvement distill proposal for ${targetFile} (${candidates.length} source entr${candidates.length === 1 ? "y" : "ies"}).`,
                "HUMAN REVIEW REQUIRED: inspect this patch before applying it to long-term behavior rules.",
                "Do not run with apply=true until the user explicitly approves this proposal.",
                "",
                patch,
              ].join("\n") }],
              details: {
                action: "distill_proposal",
                targetFile,
                applied: false,
                candidateIds: candidates.map((entry) => entry.id),
                patch,
              },
            };
          }

          const targetPath = join(workspaceDir, targetFile);
          const appendBlock = [
            "",
            "## Self-Improvement Distilled Rules",
            ...patch.split("\n").filter((line) => line.startsWith("+- ")).map((line) => line.slice(1)),
            "",
          ].join("\n");
          const previous = await readFile(targetPath, "utf-8").catch(() => "");
          await writeFile(targetPath, `${previous.trimEnd()}${appendBlock}`, "utf-8");

          for (const file of files) {
            const filePath = join(learningsDir, file);
            let content = await readFile(filePath, "utf-8").catch(() => "");
            for (const entry of candidates.filter((candidate) => candidate.file === file)) {
              const entryRegex = new RegExp(`## \\[${escapeRegExp(entry.id)}\\][^\\n]*[\\s\\S]*?(?=\\n## \\[(?:LRN|ERR)-|(?![\\s\\S]))`, "m");
              const match = content.match(entryRegex);
              if (!match) continue;
              let updated = match[0].includes("**Status**:")
                ? match[0].replace(/\*\*Status\*\*:\s*.+/m, "**Status**: promoted")
                : `${match[0].trimEnd()}\n**Status**: promoted\n`;
              if (!updated.includes("Promoted-To:")) {
                updated = `${updated.trimEnd()}\n- Promoted-To: ${targetFile}\n`;
              }
              content = content.replace(match[0], updated);
            }
            await writeFile(filePath, content, "utf-8");
          }

          return {
            content: [{ type: "text", text: `Applied ${candidates.length} human-approved distilled self-improvement rule(s) to ${targetFile}.` }],
            details: {
              action: "distill_applied",
              targetFile,
              applied: true,
              candidateIds: candidates.map((entry) => entry.id),
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to distill self-improvement entries: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_distill_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_distill" }
  );
}
