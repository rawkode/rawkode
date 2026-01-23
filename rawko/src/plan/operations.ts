/**
 * Plan operations for rawko-sdk
 * See SPEC-0010 for specification
 */

import type {
  Plan,
  PlanStep,
  StepCompletionResult,
  CreatePlanInput,
  CreatePlanOutput,
  ReplanInput,
  ReplanOutput,
} from "./types.ts";

/**
 * Create a new plan with initial steps.
 */
export function createPlan(
  task: string,
  steps: Array<Omit<PlanStep, "index" | "status">>,
  options: {
    createdBy?: string;
    metadata?: Plan["metadata"];
  } = {}
): Plan {
  const now = new Date().toISOString();
  const id = generatePlanId(task);

  return {
    id,
    task,
    status: "draft",
    steps: steps.map((step, index) => ({
      ...step,
      index,
      status: "pending" as const,
    })),
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? "planner",
    version: 1,
    metadata: options.metadata,
  };
}

/**
 * Generate a unique plan ID based on task and timestamp.
 */
export function generatePlanId(task: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/^-|-$/g, "");
  return `plan-${date}-${slug}`;
}

/**
 * Mark a step as starting execution.
 */
export function startStep(plan: Plan, stepIndex: number, executedBy?: string): Plan {
  validateStepIndex(plan, stepIndex);

  return {
    ...plan,
    currentStepIndex: stepIndex,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step, i) =>
      i === stepIndex
        ? {
            ...step,
            status: "in_progress" as const,
            startedAt: new Date().toISOString(),
            executedBy: executedBy ?? step.suggestedAgent,
          }
        : step
    ),
  };
}

/**
 * Mark a step as successfully completed.
 */
export function completeStep(
  plan: Plan,
  stepIndex: number,
  result: StepCompletionResult
): Plan {
  validateStepIndex(plan, stepIndex);

  const nextStepIndex = findNextPendingStep(plan, stepIndex);
  const allComplete = nextStepIndex === -1;

  return {
    ...plan,
    currentStepIndex: allComplete ? plan.steps.length : nextStepIndex,
    status: allComplete ? "complete" : "in_progress",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step, i) =>
      i === stepIndex
        ? {
            ...step,
            status: "complete" as const,
            completedAt: new Date().toISOString(),
            output: result.output,
            affectedFiles: result.affectedFiles,
          }
        : step
    ),
  };
}

/**
 * Mark a step as failed.
 */
export function failStep(plan: Plan, stepIndex: number, error: string): Plan {
  validateStepIndex(plan, stepIndex);

  return {
    ...plan,
    status: "replanning",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step, i) =>
      i === stepIndex
        ? {
            ...step,
            status: "failed" as const,
            completedAt: new Date().toISOString(),
            error,
          }
        : step
    ),
  };
}

/**
 * Skip a step (mark as skipped without executing).
 */
export function skipStep(plan: Plan, stepIndex: number, reason?: string): Plan {
  validateStepIndex(plan, stepIndex);

  const nextStepIndex = findNextPendingStep(plan, stepIndex);
  const allComplete = nextStepIndex === -1;

  return {
    ...plan,
    currentStepIndex: allComplete ? plan.steps.length : nextStepIndex,
    status: allComplete ? "complete" : plan.status,
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step, i) =>
      i === stepIndex
        ? {
            ...step,
            status: "skipped" as const,
            completedAt: new Date().toISOString(),
            output: reason ? `Skipped: ${reason}` : "Skipped",
          }
        : step
    ),
  };
}

/**
 * Find the next pending step that has all dependencies met.
 */
export function findNextPendingStep(plan: Plan, afterIndex: number): number {
  for (let i = afterIndex + 1; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.status !== "pending") continue;

    // Check dependencies
    const dependenciesMet = (step.dependsOn ?? []).every(
      (depIndex) => plan.steps[depIndex]?.status === "complete"
    );

    if (dependenciesMet) return i;
  }
  return -1; // No pending steps
}

/**
 * Check if all steps are complete.
 */
export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.every(
    (step) => step.status === "complete" || step.status === "skipped"
  );
}

/**
 * Count completed steps.
 */
export function countCompletedSteps(plan: Plan): number {
  return plan.steps.filter(
    (step) => step.status === "complete" || step.status === "skipped"
  ).length;
}

/**
 * Get the current step being worked on.
 */
export function getCurrentStep(plan: Plan): PlanStep | undefined {
  return plan.steps[plan.currentStepIndex];
}

/**
 * Get remaining pending steps.
 */
export function getRemainingSteps(plan: Plan): PlanStep[] {
  return plan.steps.filter((step) => step.status === "pending");
}

/**
 * Create a new version of a plan after replanning.
 */
export function replan(
  originalPlan: Plan,
  newSteps: Array<Omit<PlanStep, "index" | "status">>,
  options: {
    preserveCompleted?: boolean;
    createdBy?: string;
  } = {}
): Plan {
  const now = new Date().toISOString();
  const preserveCompleted = options.preserveCompleted ?? true;

  // Optionally preserve completed steps from original
  const completedSteps = preserveCompleted
    ? originalPlan.steps.filter((s) => s.status === "complete")
    : [];

  // Build new steps starting after preserved ones
  const allSteps: PlanStep[] = [
    ...completedSteps,
    ...newSteps.map((step, i) => ({
      ...step,
      index: completedSteps.length + i,
      status: "pending" as const,
    })),
  ];

  return {
    id: `${originalPlan.id.split("-v")[0]}-v${originalPlan.version + 1}`,
    task: originalPlan.task,
    status: allSteps.length > 0 ? "draft" : "complete",
    steps: allSteps,
    currentStepIndex: completedSteps.length,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? "planner",
    version: originalPlan.version + 1,
    previousPlanId: originalPlan.id,
    metadata: originalPlan.metadata,
  };
}

/**
 * Add steps to an existing plan.
 */
export function addSteps(
  plan: Plan,
  newSteps: Array<Omit<PlanStep, "index" | "status">>,
  insertAfterIndex?: number
): Plan {
  const insertPoint = insertAfterIndex ?? plan.steps.length - 1;

  const beforeSteps = plan.steps.slice(0, insertPoint + 1);
  const afterSteps = plan.steps.slice(insertPoint + 1);

  const indexedNewSteps: PlanStep[] = newSteps.map((step, i) => ({
    ...step,
    index: beforeSteps.length + i,
    status: "pending" as const,
  }));

  // Reindex steps after insertion point
  const reindexedAfterSteps = afterSteps.map((step, i) => ({
    ...step,
    index: beforeSteps.length + indexedNewSteps.length + i,
    // Update dependsOn references
    dependsOn: step.dependsOn?.map((dep) =>
      dep > insertPoint ? dep + indexedNewSteps.length : dep
    ),
  }));

  return {
    ...plan,
    updatedAt: new Date().toISOString(),
    steps: [...beforeSteps, ...indexedNewSteps, ...reindexedAfterSteps],
  };
}

/**
 * Mark a plan as failed (cannot continue).
 */
export function failPlan(plan: Plan, reason: string): Plan {
  return {
    ...plan,
    status: "failed",
    updatedAt: new Date().toISOString(),
    metadata: {
      ...plan.metadata,
      constraints: [...(plan.metadata?.constraints ?? []), `Failed: ${reason}`],
    },
  };
}

/**
 * Validate step index is within bounds.
 */
function validateStepIndex(plan: Plan, stepIndex: number): void {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    throw new Error(
      `Invalid step index ${stepIndex}. Plan has ${plan.steps.length} steps.`
    );
  }
}

/**
 * Get a summary of plan progress.
 */
export function getPlanSummary(plan: Plan): {
  status: string;
  progress: string;
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  failedSteps: number;
} {
  const completed = countCompletedSteps(plan);
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  const current = getCurrentStep(plan);

  return {
    status: plan.status,
    progress: `${completed}/${plan.steps.length}`,
    currentStep: current?.description ?? null,
    completedSteps: completed,
    totalSteps: plan.steps.length,
    failedSteps: failed,
  };
}
