/**
 * Agent Tool Definitions — Barrel
 * Re-exports from sub-modules and orchestrates tool registration.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerMemoryDoctorTool } from "./memory-doctor-tool.js";

// Re-export shared types and utilities
export { MEMORY_CATEGORIES, _resetWarnedMissingAgentIdState } from "./tools-shared.js";
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
  registerMemoryListTool,
  registerMemoryPromoteTool,
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
} from "./tools-management.js";

import type { ToolContext } from "./tools-shared.js";
import { registerMemoryRecallTool } from "./tools-recall.js";
import { registerMemoryStoreTool } from "./tools-store.js";
import { registerMemoryForgetTool } from "./tools-forget.js";
import { registerMemoryUpdateTool } from "./tools-update.js";
import { registerMemoryStatsTool } from "./tools-management.js";
import { registerMemoryDebugTool } from "./tools-management.js";
import { registerMemoryListTool } from "./tools-management.js";
import { registerMemoryPromoteTool } from "./tools-management.js";
import { registerMemoryArchiveTool } from "./tools-management.js";
import { registerMemoryCompactTool } from "./tools-management.js";
import { registerMemoryExplainRankTool } from "./tools-management.js";
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
  // Core tools (always enabled)
  registerMemoryRecallTool(api, context);
  registerMemoryStoreTool(api, context);
  registerMemoryForgetTool(api, context);
  registerMemoryUpdateTool(api, context);

  // Management tools (optional)
  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryDoctorTool(api, context);
    registerMemoryDebugTool(api, context);
    registerMemoryListTool(api, context);
    registerMemoryPromoteTool(api, context);
    registerMemoryArchiveTool(api, context);
    registerMemoryCompactTool(api, context);
    registerMemoryExplainRankTool(api, context);
  }
  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    if (options.enableManagementTools) {
      registerSelfImprovementExtractSkillTool(api, context);
      registerSelfImprovementReviewTool(api, context);
      registerSelfImprovementDistillTool(api, context);
    }
  }
}
