import type { Adapter, AdapterConfig } from "./types.ts";
import type { AdapterConfig as TypedAdapterConfig } from "../config/schema.ts";

type AdapterFactory = (config: AdapterConfig) => Promise<Adapter>;

const adapters = new Map<string, AdapterFactory>();

export function registerAdapter(type: string, factory: AdapterFactory): void {
  adapters.set(type, factory);
}

export async function createAdapter(config: TypedAdapterConfig): Promise<Adapter> {
  const factory = adapters.get(config.type);

  if (!factory) {
    throw new Error(`Unknown adapter type: ${config.type}`);
  }

  const adapter = await factory(config);
  await adapter.initialize(config);
  return adapter;
}

export async function loadBuiltinAdapters(): Promise<void> {
  const { createMarkdownAdapter } = await import("../markdown/adapter.ts");
  const { createGitHubAdapter } = await import("../github/adapter.ts");

  registerAdapter("markdown", createMarkdownAdapter);
  registerAdapter("github-issues", createGitHubAdapter);
}

export { adapters };
