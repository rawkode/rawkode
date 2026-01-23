# SPEC-0010: Plan Schema

## Abstract

This specification defines the Plan schema used to coordinate agent execution in rawko-sdk. Plans decompose tasks into steps, track progress, and enable agents to understand their role in the overall workflow.

## Motivation

Plans are central to agent coordination:
- Decompose complex tasks into manageable steps
- Track progress and status
- Enable arbiter to select appropriate agents
- Allow agents to understand context
- Provide visibility into what's been done and what remains

## Plan Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Plan Lifecycle                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │   Created   │───▶│  In Progress │───▶│  Complete   │             │
│  │             │    │              │    │             │             │
│  └─────────────┘    └──────┬───────┘    └─────────────┘             │
│        │                   │                                        │
│        │                   │ failure                                │
│        │                   ▼                                        │
│        │            ┌─────────────┐                                 │
│        │            │  Replanning │──────────────┐                  │
│        │            │             │              │                  │
│        │            └─────────────┘              │                  │
│        │                   │                     │                  │
│        │                   │ new plan            │ max retries      │
│        │                   ▼                     ▼                  │
│        │            ┌─────────────┐       ┌─────────────┐          │
│        │            │   Updated   │       │   Failed    │          │
│        │            │    Plan     │       │             │          │
│        │            └─────────────┘       └─────────────┘          │
│        │                   │                                        │
│        └───────────────────┘                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Plan Schema

### Core Types

```typescript
interface Plan {
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

type PlanStatus =
  | "draft"        // Plan created but not started
  | "in_progress"  // Execution in progress
  | "complete"     // All steps completed successfully
  | "failed"       // Plan failed, cannot continue
  | "replanning";  // Plan being revised after failure

interface PlanStep {
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

type StepStatus =
  | "pending"      // Not yet started
  | "in_progress"  // Currently being executed
  | "complete"     // Successfully completed
  | "failed"       // Failed, may need replan
  | "skipped";     // Skipped (dependencies or manual skip)

interface PlanMetadata {
  /** Estimated complexity (1-10) */
  complexity?: number;

  /** Tags for categorization */
  tags?: string[];

  /** Any constraints or requirements */
  constraints?: string[];

  /** Related memories that informed this plan */
  informedByMemories?: string[];
}
```

### Example Plan

```typescript
const examplePlan: Plan = {
  id: "plan-20260123-auth-feature",
  task: "Implement user authentication with JWT",
  status: "in_progress",
  currentStepIndex: 2,
  createdAt: "2026-01-23T10:00:00Z",
  updatedAt: "2026-01-23T10:35:00Z",
  createdBy: "planner",
  version: 1,
  steps: [
    {
      index: 0,
      description: "Analyze existing codebase structure and auth patterns",
      status: "complete",
      suggestedAgent: "planner",
      executedBy: "planner",
      startedAt: "2026-01-23T10:00:00Z",
      completedAt: "2026-01-23T10:10:00Z",
      output: "Found existing auth utilities in src/auth/",
      affectedFiles: [],
    },
    {
      index: 1,
      description: "Implement authentication middleware",
      status: "complete",
      suggestedAgent: "developer",
      executedBy: "developer",
      startedAt: "2026-01-23T10:15:00Z",
      completedAt: "2026-01-23T10:30:00Z",
      output: "Created src/auth/middleware.ts with JWT validation",
      affectedFiles: ["src/auth/middleware.ts"],
      acceptanceCriteria: [
        "Validates JWT tokens",
        "Attaches user to request",
        "Returns 401 on invalid token",
      ],
    },
    {
      index: 2,
      description: "Implement login endpoint",
      status: "in_progress",
      suggestedAgent: "developer",
      executedBy: "developer",
      startedAt: "2026-01-23T10:35:00Z",
      dependsOn: [1],
      instructions: "Create POST /auth/login endpoint that validates credentials and returns JWT",
      acceptanceCriteria: [
        "Accepts email/password",
        "Validates against user store",
        "Returns JWT on success",
        "Returns 401 on invalid credentials",
      ],
    },
    {
      index: 3,
      description: "Write integration tests for auth flow",
      status: "pending",
      suggestedAgent: "tester",
      dependsOn: [1, 2],
      acceptanceCriteria: [
        "Tests successful login",
        "Tests invalid credentials",
        "Tests token validation",
        "Tests protected routes",
      ],
    },
    {
      index: 4,
      description: "Review and validate implementation",
      status: "pending",
      suggestedAgent: "reviewer",
      dependsOn: [3],
    },
  ],
  metadata: {
    complexity: 5,
    tags: ["auth", "jwt", "api"],
    constraints: [
      "Use existing JWT library",
      "Follow Express middleware pattern",
    ],
  },
};
```

## Plan Operations

### Creating a Plan

```typescript
interface CreatePlanInput {
  task: string;
  context?: {
    existingCode?: string[];
    memories?: string[];
    constraints?: string[];
  };
}

interface CreatePlanOutput {
  plan: Plan;
  reasoning: string;
}

async function createPlan(input: CreatePlanInput): Promise<CreatePlanOutput> {
  const prompt = buildPlanningPrompt(input);
  const response = await plannerAgent.execute(prompt);
  return parsePlanResponse(response);
}
```

### Updating Plan Progress

```typescript
/** Mark a step as starting */
function startStep(plan: Plan, stepIndex: number): Plan {
  const step = plan.steps[stepIndex];
  return {
    ...plan,
    currentStepIndex: stepIndex,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((s, i) =>
      i === stepIndex
        ? { ...s, status: "in_progress", startedAt: new Date().toISOString() }
        : s
    ),
  };
}

/** Mark a step as completed */
function completeStep(
  plan: Plan,
  stepIndex: number,
  result: { output: string; affectedFiles?: string[] }
): Plan {
  const nextStepIndex = findNextPendingStep(plan, stepIndex);
  const allComplete = nextStepIndex === -1;

  return {
    ...plan,
    currentStepIndex: allComplete ? plan.steps.length : nextStepIndex,
    status: allComplete ? "complete" : "in_progress",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((s, i) =>
      i === stepIndex
        ? {
            ...s,
            status: "complete",
            completedAt: new Date().toISOString(),
            output: result.output,
            affectedFiles: result.affectedFiles,
          }
        : s
    ),
  };
}

/** Mark a step as failed */
function failStep(
  plan: Plan,
  stepIndex: number,
  error: string
): Plan {
  return {
    ...plan,
    status: "replanning",
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((s, i) =>
      i === stepIndex
        ? { ...s, status: "failed", error }
        : s
    ),
  };
}

/** Find next pending step (respecting dependencies) */
function findNextPendingStep(plan: Plan, afterIndex: number): number {
  for (let i = afterIndex + 1; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.status !== "pending") continue;

    // Check dependencies
    const dependenciesMet = (step.dependsOn || []).every(
      (depIndex) => plan.steps[depIndex].status === "complete"
    );

    if (dependenciesMet) return i;
  }
  return -1; // No pending steps
}
```

### Replanning

```typescript
interface ReplanInput {
  originalPlan: Plan;
  failedStepIndex: number;
  error: string;
  context?: {
    discoveries?: string[];
    constraints?: string[];
  };
}

interface ReplanOutput {
  newPlan: Plan;
  changes: string;
  reasoning: string;
}

async function replan(input: ReplanInput): Promise<ReplanOutput> {
  const prompt = buildReplanPrompt(input);
  const response = await plannerAgent.execute(prompt);
  const result = parseReplanResponse(response);

  return {
    newPlan: {
      ...result.newPlan,
      id: `${input.originalPlan.id}-v${input.originalPlan.version + 1}`,
      version: input.originalPlan.version + 1,
      previousPlanId: input.originalPlan.id,
    },
    changes: result.changes,
    reasoning: result.reasoning,
  };
}
```

## Plan in Arbiter Context

The arbiter uses plan information for agent selection:

```typescript
interface ArbiterContext {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastError?: string;
}

function buildArbiterPrompt(context: ArbiterContext): string {
  let prompt = `## Current Task\n\n${context.task}\n\n`;

  if (context.plan) {
    prompt += `## Plan Status\n\n`;
    prompt += `Status: ${context.plan.status}\n`;
    prompt += `Progress: ${countCompletedSteps(context.plan)}/${context.plan.steps.length} steps\n\n`;

    prompt += `## Current Step\n\n`;
    const currentStep = context.plan.steps[context.plan.currentStepIndex];
    if (currentStep) {
      prompt += `Step ${currentStep.index + 1}: ${currentStep.description}\n`;
      prompt += `Suggested agent: ${currentStep.suggestedAgent || "any"}\n`;
      if (currentStep.acceptanceCriteria) {
        prompt += `Acceptance criteria:\n`;
        currentStep.acceptanceCriteria.forEach((c) => {
          prompt += `- ${c}\n`;
        });
      }
    }

    prompt += `\n## Remaining Steps\n\n`;
    context.plan.steps
      .filter((s) => s.status === "pending")
      .forEach((s) => {
        prompt += `- Step ${s.index + 1}: ${s.description}\n`;
      });
  }

  return prompt;
}
```

## Plan Persistence

Plans are stored as part of the task execution context:

```yaml
# .rawko/current-task.yaml
task: "Implement user authentication"
planId: "plan-20260123-auth-feature"
status: in_progress

# .rawko/plans/plan-20260123-auth-feature.yaml
id: plan-20260123-auth-feature
task: "Implement user authentication with JWT"
status: in_progress
version: 1
currentStepIndex: 2
createdAt: "2026-01-23T10:00:00Z"
updatedAt: "2026-01-23T10:35:00Z"
createdBy: planner
steps:
  - index: 0
    description: "Analyze existing codebase structure"
    status: complete
    executedBy: planner
    completedAt: "2026-01-23T10:10:00Z"
  - index: 1
    description: "Implement authentication middleware"
    status: complete
    executedBy: developer
    affectedFiles:
      - src/auth/middleware.ts
  - index: 2
    description: "Implement login endpoint"
    status: in_progress
    suggestedAgent: developer
  # ... more steps
```

## Integration with XState

```typescript
// Context includes plan
interface RawkoContext {
  task: string;
  plan: Plan | null;
  // ... other fields
}

// Events for plan updates
type PlanEvent =
  | { type: "PLAN_CREATED"; plan: Plan }
  | { type: "STEP_STARTED"; stepIndex: number }
  | { type: "STEP_COMPLETED"; stepIndex: number; output: string }
  | { type: "STEP_FAILED"; stepIndex: number; error: string }
  | { type: "PLAN_REPLANNED"; newPlan: Plan };

// Machine transitions
const rawkoMachine = createMachine({
  // ...
  states: {
    planning: {
      invoke: {
        src: "planningActor",
        onDone: {
          target: "selecting",
          actions: assign({
            plan: ({ event }) => event.output.plan,
          }),
        },
      },
    },
    executing: {
      entry: ({ context }) => {
        // Start current step
        startStep(context.plan, context.plan.currentStepIndex);
      },
      // ...
    },
  },
});
```

## Drawbacks

1. **Planning overhead** - Every task requires a planning phase
2. **Plan rigidity** - Steps may need adjustment as execution proceeds
3. **Complexity tracking** - Maintaining plan state adds complexity
4. **Replan loops** - Bad plans could cause repeated replanning

## Unresolved Questions

1. How to handle tasks that don't need detailed plans (simple fixes)?
2. Should agents be able to add steps mid-execution?
3. How to handle parallel step execution?
4. What's the maximum number of replan attempts?
5. Should completed plans be archived or deleted?
