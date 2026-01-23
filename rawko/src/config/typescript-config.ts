/**
 * TypeScript-based agent configuration with Zod schema support
 *
 * Replaces YAML config with type-safe TypeScript definitions.
 * Agents can define response schemas for structured output validation.
 */

import type { z } from "zod";

// ============================================================================
// Tool Configuration
// ============================================================================

export interface BashFilter {
  allowedCommands?: string[];
  blockedPatterns?: string[];
}

export interface ToolsConfig {
  allowed?: string[];
  blocked?: string[];
  bashFilter?: BashFilter;
}

// ============================================================================
// Limits Configuration
// ============================================================================

export interface LimitsConfig {
  maxIterations?: number;
  timeout?: number;
  maxTokens?: number;
}

// ============================================================================
// Provider Configuration
// ============================================================================

export interface ProviderOverride {
  name: "claude" | "copilot" | "mock";
  model?: string;
  maxTokens?: number;
}

export interface ProviderSettings {
  model: string;
  maxTokens?: number;
}

export interface ProviderConfig {
  default: "claude" | "copilot";
  claude?: ProviderSettings;
  copilot?: ProviderSettings;
}

export interface ArbiterConfig {
  provider: "claude" | "copilot";
  model: string;
  maxTokens?: number;
  temperature?: number;
}

// ============================================================================
// Transition Configuration
// ============================================================================

/**
 * Custom transition with type-safe predicate function.
 * The predicate receives the structured response and returns true if this transition should fire.
 */
export interface CustomTransition<T> {
  /** Predicate function that receives the structured response */
  when: (response: T) => boolean;
  /** Target agent name or "complete" to finish */
  target: string;
  /** Human-readable reason for this transition */
  reason: string;
}

/**
 * Transitions configuration for agents.
 * For agents with response schemas, custom transitions can use typed predicates.
 */
export interface TransitionsConfig<T = void> {
  /** Agent to transition to on successful completion */
  onSuccess: string;
  /** Agent to transition to on failure (optional) */
  onFailure?: string;
  /** Agent to transition to when max iterations reached (optional) */
  onMaxIterations?: string;
  /** Custom predicate-based transitions (only for structured agents) */
  custom?: T extends void ? never : CustomTransition<T>[];
}

// ============================================================================
// Agent Definitions
// ============================================================================

/**
 * Base agent properties shared by all agent types.
 */
interface BaseAgentConfig {
  /** Unique identifier for this agent */
  name: string;
  /** Human-readable display name */
  displayName?: string;
  /** Description of when this agent should be used */
  whenToUse?: string;
  /** System prompt that defines the agent's behavior */
  systemPrompt: string;
  /** Tool access configuration */
  tools?: ToolsConfig;
  /** Execution limits */
  limits?: LimitsConfig;
  /** Provider override for this agent */
  provider?: ProviderOverride;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent with structured Zod response validation.
 * The LLM output will be validated against the schema and parsed as typed data.
 * Enables predicate-based custom transitions.
 */
export interface StructuredAgent<T extends z.ZodTypeAny> extends BaseAgentConfig {
  /** Zod schema for validating and typing the LLM response */
  responseSchema: T;
  /** Transitions with type-safe predicates */
  transitions: TransitionsConfig<z.infer<T>>;
}

/**
 * Agent with free-form text output (no schema).
 * Used for agents like developer that produce unstructured output.
 */
export interface FreeFormAgent extends BaseAgentConfig {
  /** No response schema - output is free-form text */
  responseSchema?: undefined;
  /** Transitions without custom predicates */
  transitions: TransitionsConfig<void>;
}

/**
 * Union type for all agent definitions.
 */
export type AgentDefinition = StructuredAgent<z.ZodTypeAny> | FreeFormAgent;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an agent has a response schema (is a structured agent).
 */
export function isStructuredAgent(
  agent: AgentDefinition
): agent is StructuredAgent<z.ZodTypeAny> {
  return agent.responseSchema !== undefined;
}

/**
 * Check if an agent is free-form (no response schema).
 */
export function isFreeFormAgent(agent: AgentDefinition): agent is FreeFormAgent {
  return agent.responseSchema === undefined;
}

// ============================================================================
// Constraints Configuration
// ============================================================================

export interface ConstraintsConfig {
  maxIterations: number;
  maxFailures: number;
  timeoutMs: number;
}

// ============================================================================
// Logging Configuration
// ============================================================================

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  format: "text" | "json";
  file?: string;
}

// ============================================================================
// Tool Defaults Configuration
// ============================================================================

export interface ToolDefaultsConfig {
  bash?: {
    globalBlockedPatterns: string[];
  };
}

// ============================================================================
// Agents Configuration
// ============================================================================

export interface AgentsConfig {
  /** Default agent to start with */
  default: string;
  /** List of agent definitions */
  definitions: AgentDefinition[];
}

// ============================================================================
// Main Configuration
// ============================================================================

/**
 * Main rawko configuration (TypeScript version).
 * Exported as default from .rawko.ts
 */
export interface RawkoTSConfig {
  version: string;
  provider: ProviderConfig;
  arbiter: ArbiterConfig;
  agents: AgentsConfig;
  constraints: ConstraintsConfig;
  logging?: LoggingConfig;
  tools?: ToolDefaultsConfig;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Define a structured agent with Zod response schema.
 * Provides type inference for the response schema and transitions.
 */
export function defineAgent<T extends z.ZodTypeAny>(
  config: StructuredAgent<T>
): StructuredAgent<T>;

/**
 * Define a free-form agent without a response schema.
 */
export function defineAgent(config: FreeFormAgent): FreeFormAgent;

/**
 * Implementation of defineAgent.
 */
export function defineAgent(config: AgentDefinition): AgentDefinition {
  return config;
}

/**
 * Define the main rawko configuration.
 * Use at the end of .rawko.ts: export default defineConfig({ ... })
 */
export function defineConfig(config: RawkoTSConfig): RawkoTSConfig {
  return config;
}
