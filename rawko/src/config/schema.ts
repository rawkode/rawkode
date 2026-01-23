/**
 * Zod validation schemas for configuration
 *
 * These schemas are used for runtime validation of configuration.
 * Since we now use TypeScript for config files, these are primarily
 * used for validating dynamic/runtime config and for documentation.
 */

import { z } from "zod";

// ============================================================================
// Tool Configuration Schemas
// ============================================================================

export const BashFilterSchema = z.object({
  allowedCommands: z.array(z.string()).optional(),
  blockedPatterns: z.array(z.string()).optional(),
});

export const ToolsConfigSchema = z.object({
  allowed: z.array(z.string()).optional(),
  blocked: z.array(z.string()).optional(),
  bashFilter: BashFilterSchema.optional(),
});

// ============================================================================
// Limits Schema
// ============================================================================

export const LimitsSchema = z.object({
  maxIterations: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

// ============================================================================
// Provider Schemas
// ============================================================================

export const ProviderOverrideSchema = z.object({
  name: z.enum(["claude", "copilot", "mock"]),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const ProviderSettingsSchema = z.object({
  model: z.string(),
  maxTokens: z.number().int().positive().optional(),
});

export const ProviderConfigSchema = z.object({
  default: z.enum(["claude", "copilot"]),
  claude: ProviderSettingsSchema.optional(),
  copilot: ProviderSettingsSchema.optional(),
});

export const ArbiterConfigSchema = z.object({
  provider: z.enum(["claude", "copilot"]),
  model: z.string(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

// ============================================================================
// Constraints Schema
// ============================================================================

export const ConstraintsConfigSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxFailures: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

// ============================================================================
// Logging Schema
// ============================================================================

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  format: z.enum(["text", "json"]),
  file: z.string().optional(),
});

// ============================================================================
// Tool Defaults Schema
// ============================================================================

export const ToolDefaultsConfigSchema = z.object({
  bash: z
    .object({
      globalBlockedPatterns: z.array(z.string()),
    })
    .optional(),
});

// ============================================================================
// Transitions Schema (for runtime validation)
// ============================================================================

/**
 * Note: Custom transitions with predicate functions cannot be fully
 * validated by Zod at runtime since functions aren't serializable.
 * This schema validates the structure but not the predicate logic.
 */
export const TransitionsConfigSchema = z.object({
  onSuccess: z.string(),
  onFailure: z.string().optional(),
  onMaxIterations: z.string().optional(),
  // Custom transitions are validated as having target and reason
  // The `when` predicate function is validated at the type level
  custom: z
    .array(
      z.object({
        target: z.string(),
        reason: z.string(),
        // when is a function - can't validate with Zod
      })
    )
    .optional(),
});

// ============================================================================
// Agent Definition Schema (partial - for runtime validation)
// ============================================================================

/**
 * Schema for validating agent definitions at runtime.
 * Note: responseSchema (Zod schema) cannot be validated by another Zod schema.
 */
export const AgentDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/i, {
      message:
        "Name must start with a letter and contain only letters, numbers, hyphens, and underscores",
    }),
  displayName: z.string().optional(),
  whenToUse: z.string().optional(),
  systemPrompt: z.string().min(1),
  tools: ToolsConfigSchema.optional(),
  transitions: TransitionsConfigSchema,
  limits: LimitsSchema.optional(),
  provider: ProviderOverrideSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  // responseSchema cannot be validated - it's a Zod schema itself
});

// ============================================================================
// Agents Config Schema
// ============================================================================

export const AgentsConfigSchema = z.object({
  default: z.string(),
  definitions: z.array(AgentDefinitionSchema),
});

// ============================================================================
// Main Config Schema
// ============================================================================

/**
 * Schema for validating the main TypeScript configuration.
 * Used for runtime validation when loading config dynamically.
 */
export const RawkoTSConfigSchema = z.object({
  version: z.string(),
  provider: ProviderConfigSchema,
  arbiter: ArbiterConfigSchema,
  agents: AgentsConfigSchema,
  constraints: ConstraintsConfigSchema,
  logging: LoggingConfigSchema.optional(),
  tools: ToolDefaultsConfigSchema.optional(),
});

// Legacy aliases for backward compatibility
export const RawkoConfigSchema = RawkoTSConfigSchema;
export const AgentConfigSchema = AgentDefinitionSchema;
