import { basename } from "node:path";
import matter from "gray-matter";
import type { AgentDefinition, ModelRoute, ProviderName } from "../types/agent.ts";

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

const VALID_PROVIDERS: ProviderName[] = ["openai", "anthropic", "github"];
const MANAGER_ALLOWED_PROVIDERS: ProviderName[] = ["openai", "anthropic"];

export function parseAgentDefinition(filePath: string, raw: string): AgentDefinition {
  const parsed = parseFrontmatter(raw, filePath);
  const data = parsed.data;

  const name = readRequiredString(data, "name", filePath);
  const useMe = readRequiredString(data, "useMe", filePath);
  const manager = readRequiredBoolean(data, "manager", filePath);
  const council = readRequiredBoolean(data, "council", filePath);
  const models = readModels(data, filePath);
  validateManagerProviders(models, manager, filePath);

  const id = basename(filePath, ".mdx");
  const systemPrompt = parsed.body.trim();
  if (!systemPrompt) {
    throw new Error(`Agent file ${filePath} has no system prompt body`);
  }

  return {
    id,
    filePath,
    name,
    useMe,
    manager,
    council,
    models,
    systemPrompt,
  };
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`Agent file ${filePath} must start with YAML frontmatter`);
  }

  const lines = normalized.split("\n");
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      closing = i;
      break;
    }
  }

  if (closing < 0) {
    throw new Error(`Agent file ${filePath} is missing frontmatter closing delimiter`);
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent file ${filePath} has invalid YAML frontmatter: ${message}`);
  }

  if (typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) {
    throw new Error(`Agent file ${filePath} frontmatter must be a mapping/object`);
  }

  return {
    data: parsed.data as Record<string, unknown>,
    body: parsed.content,
  };
}

function readRequiredString(data: Record<string, unknown>, key: string, filePath: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Agent file ${filePath} requires string frontmatter key "${key}"`);
  }
  return value.trim();
}

function readRequiredBoolean(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): boolean {
  const value = data[key];
  if (typeof value !== "boolean") {
    throw new Error(`Agent file ${filePath} requires boolean frontmatter key "${key}"`);
  }
  return value;
}

function readModels(data: Record<string, unknown>, filePath: string): ModelRoute[] {
  const thinking = readOptionalString(data, "thinking");
  const models = data.models;
  if (Array.isArray(models)) {
    const routes = models.map((raw, index) =>
      parseModelRoute(raw, filePath, `models[${index}]`, thinking)
    );
    if (routes.length === 0) {
      throw new Error(`Agent file ${filePath} has empty models list`);
    }
    return routes;
  }

  const provider = readOptionalString(data, "provider");
  const model = readOptionalString(data, "model");
  if (provider && model) {
    return [{
      provider: parseProvider(provider, filePath, "provider"),
      model,
      thinking,
    }];
  }

  throw new Error(
    `Agent file ${filePath} requires either "models" list or top-level "provider"+"model"`,
  );
}

function parseModelRoute(
  raw: unknown,
  filePath: string,
  key: string,
  inheritedThinking?: string,
): ModelRoute {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Agent file ${filePath} ${key} must be an object`);
  }

  const route = raw as Record<string, unknown>;
  const providerRaw = route.provider;
  const modelRaw = route.model;
  if (typeof providerRaw !== "string" || providerRaw.trim().length === 0) {
    throw new Error(`Agent file ${filePath} ${key}.provider must be a string`);
  }
  if (typeof modelRaw !== "string" || modelRaw.trim().length === 0) {
    throw new Error(`Agent file ${filePath} ${key}.model must be a string`);
  }

  const thinking = typeof route.thinking === "string" ? route.thinking : inheritedThinking;
  return {
    provider: parseProvider(providerRaw, filePath, `${key}.provider`),
    model: modelRaw.trim(),
    thinking,
  };
}

function parseProvider(raw: string, filePath: string, key: string): ProviderName {
  const value = raw.trim().toLowerCase();
  if (!VALID_PROVIDERS.includes(value as ProviderName)) {
    throw new Error(`Agent file ${filePath} ${key} must be one of: ${VALID_PROVIDERS.join(", ")}`);
  }
  return value as ProviderName;
}

function readOptionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateManagerProviders(
  models: ModelRoute[],
  manager: boolean,
  filePath: string,
): void {
  if (!manager) {
    return;
  }

  for (const route of models) {
    if (MANAGER_ALLOWED_PROVIDERS.includes(route.provider)) {
      continue;
    }

    throw new Error(
      `Manager agent file ${filePath} uses unsupported provider "${route.provider}". ` +
        `Allowed providers: ${MANAGER_ALLOWED_PROVIDERS.join(", ")}`,
    );
  }
}
