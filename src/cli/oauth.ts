import type { Command } from "commander";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import JSON5 from "json5";
import {
  getDefaultOauthModelForProvider,
  getOAuthProviderLabel,
  isOauthModelSupported,
  listOAuthProviders,
  normalizeOauthModel,
  normalizeOAuthProviderId,
  performOAuthLogin,
} from "../llm-oauth.js";
import { clampInt } from "../utils.js";

export interface OauthCLIContext {
  pluginId?: string;
  pluginConfig?: Record<string, unknown>;
  oauthTestHooks?: {
    openUrl?: (url: string) => void | Promise<void>;
    authorizeUrl?: (url: string) => void | Promise<void>;
    chooseProvider?: (
      providers: Array<{ id: string; label: string; defaultModel: string }>,
      currentProviderId: string,
    ) => string | Promise<string>;
  };
}

type RestorableApiKeyLlmConfig = {
  auth?: "api-key";
  apiKey?: string;
  model?: string;
  baseURL?: string;
  timeoutMs?: number;
};

type OAuthLlmBackup = {
  version: 1;
  hadLlmConfig: boolean;
  llm: RestorableApiKeyLlmConfig;
};

function resolveOpenClawConfigPath(explicit?: string): string {
  const openclawHome = resolveOpenClawHome();
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }

  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.join(openclawHome, "openclaw.json");
}

function resolveOpenClawHome(): string {
  return process.env.OPENCLAW_HOME?.trim()
    ? path.resolve(process.env.OPENCLAW_HOME.trim())
    : path.join(homedir(), ".openclaw");
}

function resolveDefaultOauthPath(): string {
  return path.join(resolveOpenClawHome(), ".mymem", "oauth.json");
}

function resolveLoginOauthPath(rawPath: unknown): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  const candidate = trimmed || resolveDefaultOauthPath();
  return path.resolve(candidate);
}

function resolveConfiguredOauthPath(configPath: string, rawPath: unknown): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return resolveDefaultOauthPath();
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(path.dirname(configPath), trimmed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOauthLlmConfig(value: unknown): boolean {
  return isPlainObject(value) && value.auth === "oauth";
}

function extractRestorableApiKeyLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: RestorableApiKeyLlmConfig = {};
  if (value.auth === "api-key") {
    result.auth = "api-key";
  }
  if (typeof value.apiKey === "string") {
    result.apiKey = value.apiKey;
  }
  if (typeof value.model === "string") {
    result.model = value.model;
  }
  if (typeof value.baseURL === "string") {
    result.baseURL = value.baseURL;
  }
  if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    result.timeoutMs = Math.trunc(value.timeoutMs);
  }
  return result;
}

function extractOauthSafeLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: RestorableApiKeyLlmConfig = {};
  if (typeof value.baseURL === "string") {
    result.baseURL = value.baseURL;
  }
  if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    result.timeoutMs = Math.trunc(value.timeoutMs);
  }
  return result;
}

function hasRestorableApiKeyLlmConfig(value: RestorableApiKeyLlmConfig): boolean {
  return Object.keys(value).length > 0;
}

function buildLogoutFallbackLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (isOauthLlmConfig(value)) {
    return extractOauthSafeLlmConfig(value);
  }
  return extractRestorableApiKeyLlmConfig(value);
}

function getOauthBackupPath(oauthPath: string): string {
  const parsed = path.parse(oauthPath);
  const fileName = parsed.ext
    ? `${parsed.name}.llm-backup${parsed.ext}`
    : `${parsed.base}.llm-backup.json`;
  return path.join(parsed.dir, fileName);
}

async function saveOauthLlmBackup(oauthPath: string, llm: unknown, hadLlmConfig: boolean): Promise<void> {
  const backupPath = getOauthBackupPath(oauthPath);
  const payload: OAuthLlmBackup = {
    version: 1,
    hadLlmConfig,
    llm: extractRestorableApiKeyLlmConfig(llm),
  };
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function loadOauthLlmBackup(oauthPath: string): Promise<OAuthLlmBackup | null> {
  const backupPath = getOauthBackupPath(oauthPath);
  try {
    const raw = await readFile(backupPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.hadLlmConfig !== "boolean") {
      return null;
    }
    return {
      version: 1,
      hadLlmConfig: parsed.hadLlmConfig,
      llm: extractRestorableApiKeyLlmConfig(parsed.llm),
    };
  } catch {
    return null;
  }
}

const OAUTH_PROVIDER_CHOICES = listOAuthProviders()
  .map((provider) => `${provider.id} (${provider.label})`)
  .join(", ");

function pickOauthProvider(currentProvider: string | undefined, overrideProvider: string | undefined): {
  providerId: string;
  source: "override" | "config" | "default";
} {
  if (overrideProvider && overrideProvider.trim()) {
    return { providerId: normalizeOAuthProviderId(overrideProvider), source: "override" };
  }

  if (currentProvider && currentProvider.trim()) {
    try {
      return { providerId: normalizeOAuthProviderId(currentProvider), source: "config" };
    } catch {
      // Fall back to the default provider when the saved config is stale or invalid.
    }
  }

  return { providerId: normalizeOAuthProviderId(), source: "default" };
}

async function promptOauthProviderSelection(
  currentProviderId: string,
  testHook?: NonNullable<OauthCLIContext["oauthTestHooks"]>["chooseProvider"],
): Promise<{ providerId: string; source: "prompt" | "default" }> {
  const providers = listOAuthProviders();
  if (providers.length === 0) {
    throw new Error("No OAuth providers are available.");
  }

  if (testHook) {
    const selected = await testHook(providers, currentProviderId);
    return { providerId: normalizeOAuthProviderId(selected), source: "prompt" };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { providerId: currentProviderId, source: "default" };
  }

  let selectedIndex = providers.findIndex((provider) => provider.id === currentProviderId);
  if (selectedIndex < 0) selectedIndex = 0;

  readline.emitKeypressEvents(process.stdin);
  const canSetRawMode = typeof process.stdin.setRawMode === "function";
  const previousRawMode = canSetRawMode ? !!process.stdin.isRaw : false;
  const menuLines = 2 + providers.length;
  let hasRendered = false;

  const render = () => {
    if (hasRendered) {
      readline.moveCursor(process.stdout, 0, -menuLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    } else {
      process.stdout.write("\n");
      hasRendered = true;
    }

    process.stdout.write("Select OAuth provider\n");
    process.stdout.write("Use arrow keys and Enter.\n");
    providers.forEach((provider, index) => {
      const marker = index === selectedIndex ? ">" : " ";
      process.stdout.write(
        `${marker} ${provider.label} (${provider.id}) [default model: ${provider.defaultModel}]\n`,
      );
    });
  };

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      if (canSetRawMode) {
        process.stdin.setRawMode(previousRawMode);
      }
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "escape") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + providers.length) % providers.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "right") {
        selectedIndex = (selectedIndex + 1) % providers.length;
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const provider = providers[selectedIndex];
        cleanup();
        resolve({ providerId: provider.id, source: "prompt" });
      }
    };

    render();
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    if (canSetRawMode) {
      process.stdin.setRawMode(true);
    }
  });
}

async function resolveOauthProviderSelection(
  currentProvider: string | undefined,
  overrideProvider: string | undefined,
  chooseProviderHook?: NonNullable<OauthCLIContext["oauthTestHooks"]>["chooseProvider"],
): Promise<{ providerId: string; source: "override" | "config" | "default" | "prompt" }> {
  if (overrideProvider && overrideProvider.trim()) {
    return pickOauthProvider(currentProvider, overrideProvider);
  }

  const initial = pickOauthProvider(currentProvider, undefined);
  return await promptOauthProviderSelection(initial.providerId, chooseProviderHook);
}

function pickOauthModel(
  providerId: string,
  currentModel: string | undefined,
  overrideModel: string | undefined,
): { model: string; source: "override" | "config" | "default" } {
  if (overrideModel && overrideModel.trim()) {
    if (!isOauthModelSupported(providerId, overrideModel)) {
      throw new Error(
        `Model "${overrideModel}" is not supported for OAuth provider ${providerId}. Use a compatible model such as ${getDefaultOauthModelForProvider(providerId)}.`,
      );
    }
    return { model: overrideModel.trim(), source: "override" };
  }

  if (isOauthModelSupported(providerId, currentModel)) {
    return { model: currentModel!.trim(), source: "config" };
  }

  return { model: getDefaultOauthModelForProvider(providerId), source: "default" };
}

async function loadOpenClawConfig(configPath: string): Promise<Record<string, any>> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON5.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid OpenClaw config at ${configPath}: expected object`);
  }
  return parsed as Record<string, any>;
}

function ensurePluginConfigRoot(config: Record<string, any>, pluginId: string): Record<string, any> {
  config.plugins ||= {};
  config.plugins.entries ||= {};
  config.plugins.entries[pluginId] ||= { enabled: true, config: {} };
  const entry = config.plugins.entries[pluginId];
  entry.enabled = true;
  entry.config ||= {};
  return entry.config as Record<string, any>;
}

async function saveOpenClawConfig(configPath: string, config: Record<string, any>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function registerOauthCommands(memory: Command, context: OauthCLIContext): void {
  const auth = memory
    .command("auth")
    .description("Manage OAuth authentication for smart-extraction LLM access");

  auth
    .command("login")
    .description("Authenticate with ChatGPT/Codex in a browser, save the plugin OAuth file, and switch this plugin to llm.auth=oauth")
    .option("--config <path>", "OpenClaw config file to update")
    .option("--provider <provider>", `OAuth provider to use (${OAUTH_PROVIDER_CHOICES})`)
    .option("--model <model>", "Override the model saved into llm.model")
    .option("--oauth-path <path>", "OAuth file path (default: ~/.openclaw/.mymem/oauth.json)")
    .option("--timeout <seconds>", "OAuth callback timeout in seconds", "120")
    .option("--no-browser", "Do not auto-open the browser; print the authorization URL only")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "mymem";
        const currentLlm = context.pluginConfig?.llm;
        const currentProvider = currentLlm && typeof currentLlm === "object" && typeof (currentLlm as any).oauthProvider === "string"
          ? String((currentLlm as any).oauthProvider)
          : undefined;
        const selectedProvider = await resolveOauthProviderSelection(
          currentProvider,
          options.provider,
          context.oauthTestHooks?.chooseProvider,
        );
        const currentModel = currentLlm && typeof currentLlm === "object" && typeof (currentLlm as any).model === "string"
          ? String((currentLlm as any).model)
          : undefined;
        const selectedModel = pickOauthModel(selectedProvider.providerId, currentModel, options.model);
        const oauthModel = normalizeOauthModel(selectedModel.model);
        const configPath = resolveOpenClawConfigPath(options.config);
        const oauthPath = resolveLoginOauthPath(options.oauthPath);
        const timeoutMs = clampInt((parseInt(options.timeout, 10) || 120) * 1000, 15_000, 900_000);

        if (selectedModel.source === "default" && currentModel && currentModel.trim()) {
          console.log(
            `Configured llm.model "${currentModel}" is not supported by provider ${selectedProvider.providerId}. Falling back to ${getDefaultOauthModelForProvider(selectedProvider.providerId)}.`,
          );
        }

        console.log(`Config file: ${configPath}`);
        console.log(`Provider: ${getOAuthProviderLabel(selectedProvider.providerId)} (${selectedProvider.providerId}, ${selectedProvider.source})`);
        console.log(`OAuth file: ${oauthPath}`);
        console.log(`Model: ${oauthModel} (${selectedModel.source})`);

        const { session } = await performOAuthLogin({
          authPath: oauthPath,
          timeoutMs,
          noBrowser: options.browser === false,
          model: selectedModel.model,
          providerId: selectedProvider.providerId,
          onOpenUrl: context.oauthTestHooks?.openUrl,
          onAuthorizeUrl: async (url) => {
            console.log(`Authorization URL: ${url}`);
            await context.oauthTestHooks?.authorizeUrl?.(url);
          },
        });

        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const hadLlmConfig = isPlainObject(pluginConfig.llm);
        const existingLlm = hadLlmConfig ? { ...(pluginConfig.llm as Record<string, unknown>) } : {};
        const wasOauthMode = isOauthLlmConfig(existingLlm);

        if (!wasOauthMode) {
          await saveOauthLlmBackup(oauthPath, pluginConfig.llm, hadLlmConfig);
        }

        const nextLlm = wasOauthMode ? { ...existingLlm } : extractOauthSafeLlmConfig(existingLlm);
        delete nextLlm.apiKey;
        if (!wasOauthMode) {
          delete nextLlm.baseURL;
        }
        pluginConfig.llm = {
          ...nextLlm,
          auth: "oauth",
          oauthProvider: selectedProvider.providerId,
          model: oauthModel,
          oauthPath,
        };
        await saveOpenClawConfig(configPath, openclawConfig);

        console.log(`OAuth login completed for account ${session.accountId}.`);
        console.log(
          `Updated ${pluginId} config: llm.auth=oauth, llm.oauthProvider=${selectedProvider.providerId}, llm.oauthPath=${oauthPath}, llm.model=${oauthModel}`,
        );
      } catch (error) {
        console.error("OAuth login failed:", error);
        process.exit(1);
      }
    });

  auth
    .command("status")
    .description("Show the current OAuth configuration for this plugin")
    .option("--config <path>", "OpenClaw config file to inspect")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "mymem";
        const configPath = resolveOpenClawConfigPath(options.config);
        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm as Record<string, unknown> : {};
        const oauthProviderRaw = typeof llm.oauthProvider === "string" && llm.oauthProvider.trim()
          ? llm.oauthProvider.trim()
          : normalizeOAuthProviderId();
        let oauthProviderDisplay = `${oauthProviderRaw} (unknown)`;
        try {
          oauthProviderDisplay = `${normalizeOAuthProviderId(oauthProviderRaw)} (${getOAuthProviderLabel(oauthProviderRaw)})`;
        } catch {
          // Leave the raw provider id visible for debugging stale or unsupported configs.
        }
        const oauthPath = resolveConfiguredOauthPath(configPath, llm.oauthPath);

        let tokenInfo = "missing";
        try {
          const session = await readFile(oauthPath, "utf8");
          tokenInfo = session.trim() ? "present" : "empty";
        } catch {
          tokenInfo = "missing";
        }

        console.log(`Config file: ${configPath}`);
        console.log(`Plugin: ${pluginId}`);
        console.log(`llm.auth: ${typeof llm.auth === "string" ? llm.auth : "api-key"}`);
        console.log(`llm.oauthProvider: ${oauthProviderDisplay}`);
        console.log(`llm.model: ${typeof llm.model === "string" ? llm.model : "openai/gpt-oss-120b"}`);
        console.log(`llm.oauthPath: ${oauthPath}`);
        console.log(`oauth file: ${tokenInfo}`);
      } catch (error) {
        console.error("OAuth status failed:", error);
        process.exit(1);
      }
    });

  auth
    .command("logout")
    .description("Delete the plugin OAuth file and switch this plugin back to llm.auth=api-key")
    .option("--config <path>", "OpenClaw config file to update")
    .option("--oauth-path <path>", "OAuth file path to remove")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "mymem";
        const configPath = resolveOpenClawConfigPath(options.config);
        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm as Record<string, unknown> : {};
        const oauthPath =
          options.oauthPath && String(options.oauthPath).trim()
            ? resolveLoginOauthPath(options.oauthPath)
            : resolveConfiguredOauthPath(configPath, llm.oauthPath);
        const backupPath = getOauthBackupPath(oauthPath);
        const backup = await loadOauthLlmBackup(oauthPath);

        await rm(oauthPath, { force: true });
        await rm(backupPath, { force: true });

        if (backup) {
          if (backup.hadLlmConfig) {
            pluginConfig.llm = { ...backup.llm };
          } else {
            delete pluginConfig.llm;
          }
        } else {
          const fallbackLlm = buildLogoutFallbackLlmConfig(llm);
          if (hasRestorableApiKeyLlmConfig(fallbackLlm)) {
            pluginConfig.llm = fallbackLlm;
          } else {
            delete pluginConfig.llm;
          }
        }
        await saveOpenClawConfig(configPath, openclawConfig);

        console.log(`Deleted OAuth file: ${oauthPath}`);
        console.log(`Updated ${pluginId} config: llm.auth=api-key`);
      } catch (error) {
        console.error("OAuth logout failed:", error);
        process.exit(1);
      }
    });
}
