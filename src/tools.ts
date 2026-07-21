/**
 * Agent Tool Definitions — Barrel
 *
 * The runtime registration surface is intentionally narrow: only the three
 * tools listed in `openclaw.plugin.json` (`mymem_recall`, `mymem_update`,
 * `mymem_doctor`) are wired here. Prior experimental management tools
 * (`mymem_stats`, `mymem_list`, `mymem_promote`, etc.) were removed in
 * 2026-07-21 because their barrel re-exports were never invoked — the
 * `enableManagementTools` config flag had been a silent no-op for an
 * extended period.
 *
 * Source files for those tools have been deleted; only the three live tools
 * remain below.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerMemoryDoctorTool } from "./memory-doctor-tool.js";
import { registerMemoryRecallTool } from "./tools-recall.js";
import { registerMemoryUpdateTool } from "./tools-update.js";

// Re-export shared types and utilities
export { MEMORY_CATEGORIES } from "./memory-categories.js";
export { _resetWarnedMissingAgentIdState } from "./tools-shared.js";
export type { MdMirrorWriter, ToolContext } from "./tools-shared.js";

// Re-export the registered tools so external callers (tests, CLI) can still
// invoke them by symbol if needed.
export { registerMemoryRecallTool } from "./tools-recall.js";
export { registerMemoryUpdateTool } from "./tools-update.js";

import type { ToolContext } from "./tools-shared.js";

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: Record<string, never> = {},
) {
  void options;
  registerMemoryRecallTool(api, context);
  registerMemoryUpdateTool(api, context);
  registerMemoryDoctorTool(api, context);
}
