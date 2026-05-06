/**
 * Agent Tool Definitions — Barrel
 * Re-exports from sub-modules and orchestrates tool registration.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerMemoryDoctorTool } from "./memory-doctor-tool.js";
import { registerMemoryRecallTool } from "./tools-recall.js";

// Re-export shared types and utilities
export { MEMORY_CATEGORIES } from "./memory-categories.js";
export { _resetWarnedMissingAgentIdState } from "./tools-shared.js";
export type { MdMirrorWriter, ToolContext } from "./tools-shared.js";

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

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    enableManagementTools?: boolean;
  } = {},
) {
  void options;
  registerMemoryRecallTool(api, context);
  registerMemoryDoctorTool(api, context);
}
