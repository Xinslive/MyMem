/**
 * OpenClaw Extension Utilities
 *
 * Helper functions for loading OpenClaw embedded Pi runner.
 */

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { EmbeddedPiRunner } from "./plugin-types.js";

const requireFromHere = createRequire(import.meta.url);
let embeddedPiRunnerPromise: Promise<EmbeddedPiRunner> | null = null;

/**
 * Converts a value to a module import specifier.
 */
export function toImportSpecifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) return trimmed;
  if (trimmed.startsWith("/")) return pathToFileURL(trimmed).href;
  return trimmed;
}

/**
 * Gets the list of possible OpenClaw extension API import specifiers.
 */
export function getExtensionApiImportSpecifiers(): string[] {
  const envPath = process.env.OPENCLAW_EXTENSION_API_PATH?.trim();
  const specifiers: string[] = [];

  if (envPath) specifiers.push(toImportSpecifier(envPath));
  specifiers.push("openclaw/dist/extensionAPI.js");

  try {
    specifiers.push(toImportSpecifier(requireFromHere.resolve("openclaw/dist/extensionAPI.js")));
  } catch {
    // ignore resolve failures and continue fallback probing
  }

  specifiers.push(toImportSpecifier("/usr/lib/node_modules/openclaw/dist/extensionAPI.js"));
  specifiers.push(toImportSpecifier("/usr/local/lib/node_modules/openclaw/dist/extensionAPI.js"));
  specifiers.push(toImportSpecifier("/opt/homebrew/lib/node_modules/openclaw/dist/extensionAPI.js"));

  return [...new Set(specifiers.filter(Boolean))];
}

/**
 * Loads the embedded Pi runner from OpenClaw extension API.
 */
export async function loadEmbeddedPiRunner(): Promise<EmbeddedPiRunner> {
  if (!embeddedPiRunnerPromise) {
    embeddedPiRunnerPromise = (async () => {
      const importErrors: string[] = [];
      for (const specifier of getExtensionApiImportSpecifiers()) {
        try {
          const mod = await import(specifier);
          const runner = (mod as Record<string, unknown>).runEmbeddedPiAgent;
          if (typeof runner === "function") return runner as EmbeddedPiRunner;
          importErrors.push(`${specifier}: runEmbeddedPiAgent export not found`);
        } catch (err) {
          importErrors.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(
        `Unable to load OpenClaw embedded runtime API. ` +
        `Set OPENCLAW_EXTENSION_API_PATH if runtime layout differs. ` +
        `Attempts: ${importErrors.join(" | ")}`
      );
    })();
  }
  return embeddedPiRunnerPromise;
}
