/**
 * Reflection CLI Runner
 *
 * Helper functions for running reflection via CLI.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { clipDiagnostic, extractJsonObjectFromOutput, extractReflectionTextFromCliResult } from "./cli-utils.js";
import { sha256Hex } from "./session-utils.js";
import { buildReflectionPrompt, buildReflectionFallbackText } from "./session-recovery-utils.js";
import { loadEmbeddedPiRunner } from "./openclaw-extension-utils.js";
import { resolveAgentPrimaryModelRef, splitProviderModel } from "./agent-config-utils.js";
import { withTimeout } from "./cli-utils.js";
import { runWithReflectionTransientRetryOnce } from "./reflection-retry.js";
import type { ReflectionThinkLevel, ReflectionErrorSignal } from "./plugin-types.js";

/**
 * Runs reflection via CLI using openclaw agent command.
 */
export async function runReflectionViaCli(params: {
  prompt: string;
  agentId: string;
  workspaceDir: string;
  timeoutMs: number;
  thinkLevel: ReflectionThinkLevel;
}): Promise<string> {
  const cliBin = process.env.OPENCLAW_CLI_BIN?.trim() || "openclaw";
  const outerTimeoutMs = Math.max(params.timeoutMs + 5000, 15000);
  const agentTimeoutSec = Math.max(1, Math.ceil(params.timeoutMs / 1000));
  const sessionId = `memory-reflection-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const args = [
    "agent",
    "--local",
    "--agent",
    params.agentId,
    "--message",
    params.prompt,
    "--json",
    "--thinking",
    params.thinkLevel,
    "--timeout",
    String(agentTimeoutSec),
    "--session-id",
    sessionId,
  ];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cliBin, args, {
      cwd: params.workspaceDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, outerTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn ${cliBin} failed: ${err.message}`));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`${cliBin} timed out after ${outerTimeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new Error(`${cliBin} exited by signal ${signal}. stderr=${clipDiagnostic(stderr)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${cliBin} exited with code ${code}. stderr=${clipDiagnostic(stderr)}`));
        return;
      }

      try {
        const parsed = extractJsonObjectFromOutput(stdout);
        const text = extractReflectionTextFromCliResult(parsed);
        if (!text) {
          reject(new Error(`CLI JSON returned no text payload. stdout=${clipDiagnostic(stdout)}`));
          return;
        }
        resolve(text);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Generates reflection text using embedded runner, CLI fallback, or minimal fallback.
 */
export async function generateReflectionText(params: {
  conversation: string;
  maxInputChars: number;
  cfg: unknown;
  agentId: string;
  workspaceDir: string;
  timeoutMs: number;
  thinkLevel: ReflectionThinkLevel;
  toolErrorSignals?: ReflectionErrorSignal[];
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ text: string; usedFallback: boolean; promptHash: string; error?: string; runner: "embedded" | "cli" | "fallback" }> {
  const prompt = buildReflectionPrompt(
    params.conversation,
    params.maxInputChars,
    params.toolErrorSignals ?? []
  );
  const promptHash = sha256Hex(prompt);
  const tempSessionFile = join(
    tmpdir(),
    `memory-reflection-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  let reflectionText: string | null = null;
  const errors: string[] = [];
  const retryState = { count: 0 };
  const onRetryLog = (level: "info" | "warn", message: string) => {
    if (level === "warn") params.logger?.warn?.(message);
    else params.logger?.info?.(message);
  };

  try {
    const result: unknown = await runWithReflectionTransientRetryOnce({
      scope: "reflection",
      runner: "embedded",
      retryState,
      onLog: onRetryLog,
      execute: async () => {
        const runEmbeddedPiAgent = await loadEmbeddedPiRunner();
        const modelRef = resolveAgentPrimaryModelRef(params.cfg, params.agentId);
        const { provider, model } = modelRef ? splitProviderModel(modelRef) : {};
        const embeddedTimeoutMs = Math.max(params.timeoutMs + 5000, 15000);

        return await withTimeout(
          runEmbeddedPiAgent({
            sessionId: `reflection-${Date.now()}`,
            sessionKey: "temp:memory-reflection",
            agentId: params.agentId,
            sessionFile: tempSessionFile,
            workspaceDir: params.workspaceDir,
            config: params.cfg,
            prompt,
            disableTools: true,
            disableMessageTool: true,
            timeoutMs: params.timeoutMs,
            runId: `memory-reflection-${Date.now()}`,
            bootstrapContextMode: "lightweight",
            thinkLevel: params.thinkLevel,
            provider,
            model,
          }),
          embeddedTimeoutMs,
          "embedded reflection run"
        );
      },
    });

    const payloads = (() => {
      if (!result || typeof result !== "object") return [];
      const maybePayloads = (result as Record<string, unknown>).payloads;
      return Array.isArray(maybePayloads) ? maybePayloads : [];
    })();

    if (payloads.length > 0) {
      const firstWithText = payloads.find((p) => {
        if (!p || typeof p !== "object") return false;
        const text = (p as Record<string, unknown>).text;
        return typeof text === "string" && text.trim().length > 0;
      }) as Record<string, unknown> | undefined;
      reflectionText = typeof firstWithText?.text === "string" ? firstWithText.text.trim() : null;
    }
  } catch (err) {
    errors.push(`embedded: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  } finally {
    await unlink(tempSessionFile).catch(() => { });
  }

  if (reflectionText) {
    return { text: reflectionText, usedFallback: false, promptHash, error: errors[0], runner: "embedded" };
  }

  try {
    reflectionText = await runWithReflectionTransientRetryOnce({
      scope: "reflection",
      runner: "cli",
      retryState,
      onLog: onRetryLog,
      execute: async () => await runReflectionViaCli({
        prompt,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        timeoutMs: params.timeoutMs,
        thinkLevel: params.thinkLevel,
      }),
    });
  } catch (err) {
    errors.push(`cli: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (reflectionText) {
    return {
      text: reflectionText,
      usedFallback: false,
      promptHash,
      error: errors.length > 0 ? errors.join(" | ") : undefined,
      runner: "cli",
    };
  }

  return {
    text: buildReflectionFallbackText(),
    usedFallback: true,
    promptHash,
    error: errors.length > 0 ? errors.join(" | ") : undefined,
    runner: "fallback",
  };
}
