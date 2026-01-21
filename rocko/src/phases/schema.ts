import { z } from "zod";
import { ExecutorConfigSchema } from "../executors/types.ts";

// JSON Schema-like definition for output validation
export const JSONSchemaPropertySchema: z.ZodType<JSONSchemaProperty> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "boolean", "object", "array"]).optional(),
    enum: z.array(z.string()).optional(),
    required: z.array(z.string()).optional(),
    properties: z.record(JSONSchemaPropertySchema).optional(),
    items: JSONSchemaPropertySchema.optional(),
  })
);

export interface JSONSchemaProperty {
  type?: "string" | "number" | "boolean" | "object" | "array";
  enum?: string[];
  required?: string[];
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty;
}

export const OutputSchemaConfigSchema = z.object({
  schema: JSONSchemaPropertySchema,
});

export type OutputSchemaConfig = z.infer<typeof OutputSchemaConfigSchema>;

// Transition configuration
export const TransitionAssignSchema = z.record(z.string());

export type TransitionAssign = z.infer<typeof TransitionAssignSchema>;

export const TransitionConfigSchema = z.object({
  event: z.string(),
  target: z.string(),
  when: z.string().optional(), // JavaScript expression evaluated against context
  assign: TransitionAssignSchema.optional(), // Map response fields to context
  guard: z.string().optional(), // Additional guard expression
});

export type TransitionConfig = z.infer<typeof TransitionConfigSchema>;

// AI configuration for the phase
export const PhaseAIConfigSchema = z.object({
  maxTurns: z.number().default(5),
  model: z.string().optional(),
  executor: ExecutorConfigSchema.optional(), // Defaults to direct if not specified
});

export type PhaseAIConfig = z.infer<typeof PhaseAIConfigSchema>;

// Main phase frontmatter schema
export const PhaseFrontmatterSchema = z.object({
  name: z.string(),
  id: z.string().optional(), // Derived from filename if omitted
  initial: z.boolean().default(false),
  final: z.boolean().default(false),
  output: OutputSchemaConfigSchema.optional(),
  transitions: z.array(TransitionConfigSchema).default([]),
  ai: PhaseAIConfigSchema.optional(),
});

export type PhaseFrontmatter = z.infer<typeof PhaseFrontmatterSchema>;

// Full phase config including prompts extracted from markdown body
// Note: id is required here (derived from filename if not in frontmatter)
export const PhaseConfigSchema = PhaseFrontmatterSchema.extend({
  id: z.string(), // Override optional to required
  systemPrompt: z.string().optional(),
  userPromptTemplate: z.string().optional(),
  filePath: z.string(), // Original file path for error messages
});

export type PhaseConfig = z.infer<typeof PhaseConfigSchema>;

// Validated phase graph
export interface PhaseGraph {
  phases: Map<string, PhaseConfig>;
  initialPhaseId: string;
  finalPhaseIds: string[];
}

// Phase execution context - what's available during template rendering and condition evaluation
export interface PhaseExecutionContext {
  // From adapter
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    source: string;
    priority?: string;
    labels?: string[];
  }>;
  additionalContext?: string;

  // From machine context
  iteration: number;
  maxIterations: number;
  currentPhase: string;
  task?: unknown;
  plan?: unknown;
  build?: unknown;
  review?: unknown;
  commit?: unknown;
  error?: string;
  history: Array<{
    phase: string;
    timestamp: Date;
    event: string;
    data?: unknown;
  }>;
}

// Result of phase execution
export interface PhaseExecutionResult {
  event: string;
  response?: unknown;
  assignments?: Record<string, string>;
}

// Errors
export class PhaseConfigError extends Error {
  constructor(
    message: string,
    public filePath: string,
    public details?: unknown
  ) {
    super(`${message} (in ${filePath})`);
    this.name = "PhaseConfigError";
  }
}

export class PhaseGraphError extends Error {
  constructor(
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "PhaseGraphError";
  }
}

export class NoPhaseConfiguredError extends Error {
  constructor() {
    super("No phases configured. Run `rocko init` to create default phases.");
    this.name = "NoPhaseConfiguredError";
  }
}
