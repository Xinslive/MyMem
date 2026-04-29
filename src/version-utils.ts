/**
 * Version Utilities
 *
 * Helper functions for version detection.
 */

import { readFileSync } from "node:fs";

/**
 * Returns the plugin version from package.json.
 */
export function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
      version?: string;
    };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
