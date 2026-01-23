/**
 * Plan types for rawko-sdk
 * See SPEC-0010 for full specification
 */

/**
 * Plan status indicating overall state
 */
export type PlanStatus =
  | "draft"        // Plan created but not started
  | "in_progress"  // Execution in progress
  | "complete"     // All steps completed successfully
  | "failed"       // Plan failed, cannot continue
  | "replanning";  // Plan being revised after failure

/**
 * Step status within a plan
 */
export type StepStatus =
  | "pending"      // Not yet started
  | "in_progress"  // Currently being executed
  | "complete"     // Successfully completed
  | "failed"       // Failed, may need replan
  | "skipped";     // Skipped (dependencies or manual skip)

/**
 * Metadata for categorization and tracking
 */
export interface PlanMetadata {
  /** Estimated complexity (1-10) */
  complexity?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Any constraints or requirements */
  constraints?: string[];
  /** Related memories that informed this plan */
  informedByMemories?: string[];
}

/**
 * Individual step within a plan
 */
export interface PlanStep {
  /** Step index (0-based) */
  index: number;
  /** Human-readable description */
  description: string;
  /** Step status */
  status: StepStatus;
  /** Recommended agent type for this step */
  suggestedAgent?: string;
  /** Which agent actually executed this step */
  executedBy?: string;
  /** When step execution started */
  startedAt?: string;
  /** When step execution completed */
  completedAt?: string;
  /** Output/result from step execution */
  output?: string;
  /** Error if step failed */
  error?: string;
  /** Files affected by this step */
  affectedFiles?: string[];
  /** Dependencies on other steps (by index) */
  dependsOn?: number[];
  /** Optional detailed instructions */
  instructions?: string;
  /** Acceptance criteria for this step */
  acceptanceCriteria?: string[];
}

/**
 * Full plan structure (SPEC-0010)
 */
export interface Plan {
  /** Unique identifier for this plan */
  id: string;
  /** Original task this plan addresses */
  task: string;
  /** Plan status */
  status: PlanStatus;
  /** Ordered list of steps */
  steps: PlanStep[];
  /** Index of current/next step to execute */
  currentStepIndex: number;
  /** When the plan was created */
  createdAt: string;
  /** When the plan was last updated */
  updatedAt: string;
  /** Which agent created this plan */
  createdBy: string;
  /** Version for tracking replans */
  version: number;
  /** Previous plan version (if replanned) */
  previousPlanId?: string;
  /** Optional metadata */
  metadata?: PlanMetadata;
}

/**
 * Input for creating a new plan
 */
export interface CreatePlanInput {
  task: string;
  context?: {
    existingCode?: string[];
    memories?: string[];
    constraints?: string[];
  };
}

/**
 * Output from plan creation
 */
export interface CreatePlanOutput {
  plan: Plan;
  reasoning: string;
}

/**
 * Result of completing a step
 */
export interface StepCompletionResult {
  output: string;
  affectedFiles?: string[];
}

/**
 * Input for replanning after failure
 */
export interface ReplanInput {
  originalPlan: Plan;
  failedStepIndex: number;
  error: string;
  context?: {
    discoveries?: string[];
    constraints?: string[];
  };
}

/**
 * Output from replanning
 */
export interface ReplanOutput {
  newPlan: Plan;
  changes: string;
  reasoning: string;
}
