/**
 * Configuration loading for rawko-sdk
 *
 * Loads TypeScript-based configuration from .rawko.ts files.
 * YAML configuration is no longer supported.
 */

import type {
  RawkoTSConfig,
  AgentDefinition,
} from "./typescript-config.ts";

/**
 * Default config file name.
 */
const CONFIG_FILE_NAME = ".rawko.ts";

/**
 * Load the main configuration from a TypeScript file.
 *
 * @param basePath - Directory containing the .rawko.ts file
 * @returns The loaded configuration
 * @throws Error if config file not found or invalid
 */
export async function loadConfig(basePath: string): Promise<RawkoTSConfig> {
  // Resolve to absolute path, then convert to file URL for dynamic import
  const absolutePath = basePath.startsWith("/")
    ? `${basePath}/${CONFIG_FILE_NAME}`
    : `${Deno.cwd()}/${basePath}/${CONFIG_FILE_NAME}`.replace(/\/\.\//g, "/");

  const configUrl = `file://${absolutePath}`;

  try {
    // Dynamic import of the TypeScript config file
    const module = await import(configUrl);

    if (!module.default) {
      throw new Error(
        `Config file at ${absolutePath} must export a default configuration. ` +
          `Use: export default defineConfig({ ... })`
      );
    }

    const config = module.default as RawkoTSConfig;

    // Validate required fields
    validateConfig(config, absolutePath);

    return config;
  } catch (error) {
    if ((error as Error).message?.includes("Module not found")) {
      throw new Error(
        `Configuration file not found at ${absolutePath}. ` +
          `Create a .rawko.ts file in your project root.`
      );
    }
    throw error;
  }
}

/**
 * Validate that the config has all required fields.
 */
function validateConfig(config: RawkoTSConfig, path: string): void {
  if (!config.version) {
    throw new Error(`Config at ${path} missing required field: version`);
  }
  if (!config.provider) {
    throw new Error(`Config at ${path} missing required field: provider`);
  }
  if (!config.arbiter) {
    throw new Error(`Config at ${path} missing required field: arbiter`);
  }
  if (!config.agents) {
    throw new Error(`Config at ${path} missing required field: agents`);
  }
  if (!config.agents.definitions || config.agents.definitions.length === 0) {
    throw new Error(
      `Config at ${path} must have at least one agent definition`
    );
  }
  if (!config.constraints) {
    throw new Error(`Config at ${path} missing required field: constraints`);
  }
}

/**
 * Get agents from the loaded configuration as a Map.
 *
 * @param config - The loaded configuration
 * @returns Map of agent name to agent definition
 */
export function getAgentsFromConfig(
  config: RawkoTSConfig
): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();

  for (const agent of config.agents.definitions) {
    agents.set(agent.name, agent);
  }

  return agents;
}

/**
 * Get the default agent from the configuration.
 *
 * @param config - The loaded configuration
 * @returns The default agent definition
 * @throws Error if default agent not found
 */
export function getDefaultAgent(config: RawkoTSConfig): AgentDefinition {
  const defaultName = config.agents.default;
  const agent = config.agents.definitions.find((a) => a.name === defaultName);

  if (!agent) {
    throw new Error(
      `Default agent '${defaultName}' not found in agent definitions`
    );
  }

  return agent;
}

/**
 * Validation result for agent set.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate agent configurations as a set.
 * Checks for valid transition targets and potential issues.
 */
export function validateAgentSet(
  agents: Map<string, AgentDefinition>
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [name, config] of agents) {
    // Collect all transition targets
    const targets = [
      config.transitions.onSuccess,
      config.transitions.onFailure,
      config.transitions.onMaxIterations,
    ].filter(Boolean);

    // Add custom transition targets if present
    if ("custom" in config.transitions && config.transitions.custom) {
      for (const custom of config.transitions.custom) {
        targets.push(custom.target);
      }
    }

    // Validate each target exists
    for (const target of targets) {
      // "complete" is a special terminal state, not an agent
      if (target === "complete") continue;

      if (!agents.has(target!)) {
        errors.push(`Agent '${name}' references unknown agent '${target}'`);
      }
    }

    // Warn about self-transitions on success
    if (config.transitions.onSuccess === name) {
      warnings.push(
        `Agent '${name}' transitions to itself on success (potential infinite loop)`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Convert TypeScript config types to the legacy AgentConfig format
 * for backward compatibility with existing code.
 *
 * @param agent - The TypeScript agent definition
 * @returns Legacy-compatible agent config
 */
export function toLegacyAgentConfig(agent: AgentDefinition): LegacyAgentConfig {
  return {
    name: agent.name,
    displayName: agent.displayName,
    whenToUse: agent.whenToUse,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    transitions: {
      onSuccess: agent.transitions.onSuccess,
      onFailure: agent.transitions.onFailure,
      onMaxIterations: agent.transitions.onMaxIterations,
      // Custom transitions are handled separately - they use predicates now
      custom: undefined,
    },
    limits: agent.limits,
    provider: agent.provider,
    metadata: agent.metadata,
  };
}

/**
 * Legacy agent config format for backward compatibility.
 * Used by parts of the codebase that haven't been updated yet.
 */
export interface LegacyAgentConfig {
  name: string;
  displayName?: string;
  whenToUse?: string;
  systemPrompt: string;
  tools?: {
    allowed?: string[];
    blocked?: string[];
    bashFilter?: {
      allowedCommands?: string[];
      blockedPatterns?: string[];
    };
  };
  transitions: {
    onSuccess: string;
    onFailure?: string;
    onMaxIterations?: string;
    custom?: { condition: string; target: string }[];
  };
  limits?: {
    maxIterations?: number;
    timeout?: number;
    maxTokens?: number;
  };
  provider?: {
    name: "claude" | "copilot" | "mock";
    model?: string;
    maxTokens?: number;
  };
  metadata?: Record<string, unknown>;
}
