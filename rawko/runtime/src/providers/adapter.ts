import type { ModelRoute, ProviderName } from "../types/agent.ts";

export interface AdapterRequest {
  agentId: string;
  agentName: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  route: ModelRoute;
}

export interface StructuredAdapterRequest extends AdapterRequest {
  outputSchema: Record<string, unknown>;
}

export interface ProviderAdapter {
  provider: ProviderName;
  prewarm?(): Promise<void>;
  invoke(request: AdapterRequest): Promise<string>;
  invokeStructured(request: StructuredAdapterRequest): Promise<unknown>;
}
