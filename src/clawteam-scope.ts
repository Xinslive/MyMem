/**
 * ClawTeam Shared Memory Scope Integration
 *
 * Provides env-var-driven scope extension for ClawTeam multi-agent setups.
 * When CLAWTEAM_MEMORY_SCOPE is set, agents gain access to the specified
 * team scopes in addition to their own default scopes.
 *
 * Note: this extends `getAccessibleScopes()`, which MemoryScopeManager's
 * `isAccessible()` and `getScopeFilter()` both delegate to. So the extra
 * scopes affect both read and write access checks. The default *write target*
 * (getDefaultScope) is NOT changed — agents still write to their own scope
 * unless they explicitly specify a team scope.
 */

import type { MemoryScopeManager } from "./scopes.js";

/**
 * Parse the CLAWTEAM_MEMORY_SCOPE env var value into a list of scope names.
 * Supports comma-separated values, trims whitespace, and filters empty strings.
 *
 * P2-3 hardening: also filters out entries that do not match the known
 * scope-naming pattern (`team:*`, `project:*`, `custom:*`). Misspelled
 * entries are dropped with a one-time console.warn so an operator can spot
 * the typo without accidentally widening everyone's ACL. To suppress for
 * unusual-but-valid custom names, set MYMEM_CLAWTEAM_ALLOW_ANY=1.
 */
const KNOWN_CLAWTEAM_SCOPE_PREFIXES = ["team:", "project:", "custom:"] as const;
const ALLOW_ANY = process.env["MYMEM_CLAWTEAM_ALLOW_ANY"] === "1";
const warnedScopes = new Set<string>();

function isKnownClawteamScopeName(scope: string): boolean {
  if (ALLOW_ANY) return true;
  return KNOWN_CLAWTEAM_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

export function parseClawteamScopes(envValue: string | undefined): string[] {
  if (!envValue) return [];
  const raw = envValue.split(",").map(s => s.trim()).filter(Boolean);
  const accepted: string[] = [];
  for (const scope of raw) {
    if (!isKnownClawteamScopeName(scope)) {
      if (!warnedScopes.has(scope)) {
        warnedScopes.add(scope);
        console.warn(
          `[mymem] CLAWTEAM_MEMORY_SCOPE: dropping "${scope}" — must start with one of ` +
            KNOWN_CLAWTEAM_SCOPE_PREFIXES.join(", ") +
            ` (set MYMEM_CLAWTEAM_ALLOW_ANY=1 to bypass).`,
        );
      }
      continue;
    }
    accepted.push(scope);
  }
  return accepted;
}

/**
 * Register ClawTeam scopes and extend the scope manager's accessible scopes.
 *
 * 1. Registers scope definitions for any scopes not already defined.
 * 2. Wraps `getAccessibleScopes()` to include the extra scopes for all agents.
 *
 * Designed for MemoryScopeManager specifically, where `isAccessible()` and
 * `getScopeFilter()` delegate to `getAccessibleScopes()`. Custom ScopeManager
 * implementations may need additional patching.
 */
export function applyClawteamScopes(
  scopeManager: MemoryScopeManager,
  scopes: string[],
): void {
  if (scopes.length === 0) return;

  // Register scope definitions for unknown scopes
  for (const scope of scopes) {
    if (!scopeManager.getScopeDefinition(scope)) {
      scopeManager.addScopeDefinition(scope, {
        description: `ClawTeam shared scope: ${scope}`,
      });
    }
  }

  // Wrap getAccessibleScopes to include extra scopes
  // Copy the base array to avoid mutating the manager's internal state
  const originalGetAccessibleScopes = scopeManager.getAccessibleScopes.bind(scopeManager);
  scopeManager.getAccessibleScopes = (agentId?: string): string[] => {
    const base = originalGetAccessibleScopes(agentId);
    const result = [...base];
    for (const s of scopes) {
      if (!result.includes(s)) result.push(s);
    }
    return result;
  };
}
