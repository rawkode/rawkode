/**
 * Arbiter types for rawko-sdk
 * See SPEC-0006 for context construction details
 */

import { z } from "zod";
import type { AgentConfig, ArbiterConfig } from "../config/types.ts";
import type { TokenUsage } from "../providers/types.ts";
import type { MemoryMetadata } from "../memory/types.ts";

// Re-export Plan types from plan module for convenience
export type {
  Plan,
  PlanStep,
  PlanStatus,
  StepStatus,
  PlanMetadata,
} from "../plan/types.ts";

// Import Plan for use in this file
import type { Plan } from "../plan/types.ts";

/**
 * Raw execution entry stored in machine context
 */
export interface ExecutionEntry {
  agent: string;
  startedAt: Date;
  completedAt: Date | null;
  result: "success" | "failure" | "cancelled";
  output?: string;
  error?: string;
  tokenUsage?: TokenUsage;
}

/**
 * Summary of an execution for arbiter context (SPEC-0006)
 */
export interface ExecutionSummary {
  /** Agent name */
  agent: string;
  /** Iteration count */
  iteration: number;
  /** Execution status */
  status: "success" | "failure" | "timeout" | "cancelled";
  /** How long agent worked */
  durationMs: number;
  /** Execution output details */
  output?: {
    /** First N characters */
    summary: string;
    /** Files changed */
    filesModified?: string[];
  };
  /** Error information if failed */
  error?: {
    message: string;
    category: ErrorCategory;
    tool?: string;
    recoveryOptions?: string[];
  };
  /** Resource usage */
  tokens?: TokenUsage;
  /** ISO timestamps */
  startedAt: string;
  completedAt?: string;
}

/**
 * Error categories for classification
 */
export type ErrorCategory =
  | "tool_failure"
  | "provider_error"
  | "validation_error"
  | "timeout"
  | "permission_error"
  | "unknown";

/**
 * Rich error context for arbiter reasoning (SPEC-0006)
 */
export interface ErrorContext {
  /** Which agent encountered the error */
  agent: string;
  /** Which tool failed (if applicable) */
  tool?: string;
  /** Plan step being worked on */
  planStep?: number;
  /** What was being attempted */
  attempted: string;
  /** The actual error message */
  message: string;
  /** Error category for classification */
  category: ErrorCategory;
  /** Recovery strategies arbiter can choose */
  recoveryOptions: RecoveryOption[];
  /** When the error occurred */
  timestamp: string;
  /** Context about what was happening */
  context: {
    filesAccessed?: string[];
    commandExecuted?: string;
  };
}

/**
 * Recovery option for error handling
 */
export interface RecoveryOption {
  action: "retry" | "skip" | "fallback" | "abort";
  description: string;
  reason: string;
}

/**
 * Current execution constraints and progress metrics (SPEC-0006)
 */
export interface ConstraintContext {
  /** Total iterations allowed */
  maxIterations: number;
  /** Current iteration count */
  currentIteration: number;
  /** Remaining iterations */
  iterationsRemaining: number;
  /** Consecutive failures so far */
  consecutiveFailures: number;
  /** Maximum consecutive failures allowed */
  maxConsecutiveFailures: number;
  /** Estimated tokens used so far */
  estimatedTokensUsed?: number;
  /** Time elapsed in ms */
  timeElapsedMs?: number;
}

/**
 * Agent description for arbiter selection
 */
export interface AgentDescription {
  name: string;
  displayName: string;
  whenToUse?: string;
  tools?: {
    allowed?: string[];
    blocked?: string[];
  };
}

export type ArbiterDecision =
  | SelectModeDecision
  | ContinueDecision
  | CompleteDecision
  | RetryDecision;

export interface SelectModeDecision {
  type: "SELECT_MODE";
  mode: string;
  reason: string;
}

export interface ContinueDecision {
  type: "CONTINUE";
  reason: string;
}

export interface CompleteDecision {
  type: "COMPLETE";
  summary: string;
}

export interface RetryDecision {
  type: "RETRY";
  reason: string;
}

/**
 * Input for selecting the next agent (SPEC-0006)
 */
export interface SelectAgentInput {
  /** Original task description */
  task: string;
  /** Current plan (if exists) */
  plan: Plan | null;
  /** Recent execution history (summarized) */
  history: ExecutionSummary[];
  /** Last error with rich context */
  lastError: ErrorContext | null;
  /** Available agents with descriptions */
  availableAgents: AgentDescription[];
  /** Current constraints and progress */
  constraints: ConstraintContext;
  /** Default agent to start with */
  defaultAgent?: string;
}

/**
 * Input for evaluating progress (SPEC-0006)
 */
export interface EvaluateProgressInput {
  /** Original task */
  task: string;
  /** Current plan state */
  plan: Plan | null;
  /** Last agent's execution result (with full details) */
  lastExecution: ExecutionSummary;
  /** Full execution history for patterns */
  history: ExecutionSummary[];
  /** Current constraints */
  constraints: ConstraintContext;
}

/**
 * Legacy input types for backward compatibility
 */
export interface LegacySelectAgentInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastError: Error | null;
  availableAgents: AgentConfig[];
  defaultAgent?: string;
}

export interface LegacyEvaluateProgressInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastExecution: ExecutionEntry;
}

// ============================================================================
// Execution Plan Types - Zod schemas for structured output validation
// ============================================================================

/**
 * Zod schema for a single step in the execution plan
 */
export const ExecutionPlanStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  agent: z.string(),
  objective: z.string(),
  inputContext: z.array(z.string()),
  expectedOutputs: z.array(z.string()),
  rationale: z.string(),
  dependsOn: z.array(z.number().int().nonnegative()),
});

/**
 * Zod schema for the execution plan (returned by LLM)
 */
export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(ExecutionPlanStepSchema).min(1),
  reasoning: z.string(),
  estimatedComplexity: z.number().int().min(1).max(10),
  confidence: z.enum(["high", "medium", "low"]),
  informedByMemories: z.array(z.string()),
  warnings: z.array(z.string()),
});

/**
 * TypeScript type for a single execution plan step
 */
export type ExecutionPlanStep = z.infer<typeof ExecutionPlanStepSchema>;

/**
 * TypeScript type for the base execution plan (from LLM)
 */
export type ExecutionPlanBase = z.infer<typeof ExecutionPlanSchema>;

/**
 * Full execution plan with metadata added after generation
 */
export interface ExecutionPlan extends ExecutionPlanBase {
  /** Unique identifier for this plan */
  id: string;
  /** The original task that generated this plan */
  task: string;
  /** When the plan was created */
  createdAt: string;
  /** Plan version (for future replanning) */
  version: number;
}

/**
 * Input for generating an execution plan
 */
export interface GeneratePlanInput {
  /** The user's task description */
  task: string;
  /** Available memory metadata for context */
  memories: MemoryMetadata[];
  /** Available agents and their configurations */
  agents: Map<string, AgentConfig>;
  /** Arbiter configuration */
  arbiterConfig: ArbiterConfig;
}

/**
 * Output from plan generation
 */
export interface GeneratePlanOutput {
  /** The generated execution plan */
  plan: ExecutionPlan;
  /** Overall confidence in the plan */
  confidence: "high" | "medium" | "low";
  /** Any warnings about the plan */
  warnings: string[];
}
