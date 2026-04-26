declare module "openclaw/plugin-sdk" {
  export interface OpenClawLogger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }

  export interface OpenClawToolContent {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  export interface OpenClawToolResult {
    content?: OpenClawToolContent[];
    details?: unknown;
    [key: string]: unknown;
  }

  export interface OpenClawToolRuntimeContext {
    agentId?: string;
    sessionKey?: string;
    [key: string]: unknown;
  }

  export type OpenClawToolExecute = (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    runtimeCtx?: OpenClawToolRuntimeContext,
  ) => OpenClawToolResult | Promise<OpenClawToolResult>;

  export interface OpenClawToolDefinition {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: OpenClawToolExecute;
    [key: string]: unknown;
  }

  export type OpenClawToolFactory = (toolCtx: Record<string, unknown>) => OpenClawToolDefinition | Record<string, unknown>;

  export interface OpenClawPluginApi {
    logger: OpenClawLogger;
    resolvePath(path: string): string;
    registerTool(definition: OpenClawToolDefinition | OpenClawToolFactory, options?: unknown): void;
    registerCommand?(definition: any, options?: any): void;
    registerCli?(definition: unknown, options?: unknown): void;
    registerHook?(name: string, handler: (...args: any[]) => any, options?: unknown): void;
    registerService?(definition: unknown): void;
    command?(name: string, handler: (...args: any[]) => any): void;
    hook?(name: string, handler: (...args: any[]) => any): void;
    on(event: string, handler: (...args: any[]) => any, options?: any): void;
    [key: string]: unknown;
  }
}
