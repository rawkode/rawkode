/**
 * Configuration types for rawko-sdk
 *
 * Re-exports from typescript-config.ts for backward compatibility.
 * New code should import directly from typescript-config.ts.
 */

// Re-export all types from the TypeScript config module
export type {
  // Provider types
  ProviderConfig,
  ProviderSettings,
  ProviderOverride,
  ArbiterConfig,

  // Agent types
  AgentDefinition,
  StructuredAgent,
  FreeFormAgent,
  AgentsConfig,

  // Tool types
  ToolsConfig,
  BashFilter,

  // Transition types
  TransitionsConfig,
  CustomTransition,

  // Limits types
  LimitsConfig,

  // Constraint types
  ConstraintsConfig,

  // Logging types
  LoggingConfig,

  // Tool defaults types
  ToolDefaultsConfig,

  // Main config type
  RawkoTSConfig,
} from "./typescript-config.ts";

// Re-export helpers
export {
  defineAgent,
  defineConfig,
  isStructuredAgent,
  isFreeFormAgent,
} from "./typescript-config.ts";

// Legacy type aliases for backward compatibility
// These will be deprecated in a future version
export type { RawkoTSConfig as RawkoConfig } from "./typescript-config.ts";
export type { AgentDefinition as AgentConfig } from "./typescript-config.ts";
