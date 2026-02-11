export type ProviderName = "openai" | "anthropic" | "github";

export interface ModelRoute {
  provider: ProviderName;
  model: string;
  thinking?: string;
}

export interface AgentDefinition {
  id: string;
  filePath: string;
  name: string;
  useMe: string;
  manager: boolean;
  council: boolean;
  models: ModelRoute[];
  systemPrompt: string;
}

export interface AgentPool {
  all: AgentDefinition[];
  manager: AgentDefinition;
  council: AgentDefinition[];
  byId: Map<string, AgentDefinition>;
}
