/**
 * Agent Tool Definitions — Barrel
 * Re-exports from sub-modules and orchestrates tool registration.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerMemoryDoctorTool } from "./memory-doctor-tool.js";

// Re-export shared types and utilities
export { MEMORY_CATEGORIES } from "./memory-categories.js";
export { _resetWarnedMissingAgentIdState } from "./tools-shared.js";
export type { MdMirrorWriter, ToolContext } from "./tools-shared.js";

// Re-export self-improvement tools
export {
  registerSelfImprovementLogTool,
  registerSelfImprovementExtractSkillTool,
  registerSelfImprovementReviewTool,
  registerSelfImprovementDistillTool,
} from "./tools-self-improvement.js";

// Re-export core tools
export { registerMemoryRecallTool } from "./tools-recall.js";
export { registerMemoryStoreTool } from "./tools-store.js";
export { registerMemoryForgetTool } from "./tools-forget.js";
export { registerMemoryUpdateTool } from "./tools-update.js";

// Re-export management tools
export {
  registerMemoryStatsTool,
  registerMemoryDebugTool,
  registerMemoryExplainTool,
  registerMemoryListTool,
  registerMemoryPromoteTool,
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
} from "./tools-management.js";

import type { ToolContext } from "./tools-shared.js";
import {
  registerSelfImprovementLogTool,
  registerSelfImprovementExtractSkillTool,
  registerSelfImprovementReviewTool,
  registerSelfImprovementDistillTool,
} from "./tools-self-improvement.js";

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    enableManagementTools?: boolean;
    enableSelfImprovementTools?: boolean;
  } = {},
) {
  registerMemoryDoctorTool(api, context);

  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    registerSelfImprovementExtractSkillTool(api, context);
    registerSelfImprovementReviewTool(api, context);
    registerSelfImprovementDistillTool(api, context);
  }
}
