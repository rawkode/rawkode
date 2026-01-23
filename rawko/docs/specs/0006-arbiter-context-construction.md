# SPEC-0006: Arbiter Context Construction

## Abstract

This specification defines how the rawko-sdk XState machine constructs inputs for arbiter decision-making, including data selection, formatting, and context enrichment strategies.

## Motivation

The arbiter's decision quality depends entirely on the context it receives. Clear construction rules ensure:

- Consistent input quality
- Predictable decision reasoning
- Minimal token waste
- Effective error context propagation
- Reproducible decisions for debugging

## Detailed Design

### Arbiter Input Types

Two key input types guide arbiter decisions:

```typescript
/**
 * Input for selecting the next agent to work.
 * Used in `selecting` state.
 */
interface SelectAgentInput {
  /** Original task description from user */
  task: string;

  /** Current plan (if exists) with step status */
  plan: Plan | null;

  /** Recent execution history (truncated) */
  history: ExecutionSummary[];

  /** Last error with context (if any) */
  lastError: ErrorContext | null;

  /** All available agents with their descriptions */
  availableAgents: AgentDescription[];

  /** Current constraints and metrics */
  constraints: ConstraintContext;
}

/**
 * Input for evaluating progress and deciding next action.
 * Used in `evaluating` state.
 */
interface EvaluateProgressInput {
  /** Original task */
  task: string;

  /** Current plan state */
  plan: Plan | null;

  /** Last agent's execution result */
  lastExecution: ExecutionSummary;

  /** Full execution history for patterns */
  history: ExecutionSummary[];

  /** Current iteration and limits */
  constraints: ConstraintContext;
}
```

### Construction Algorithms

#### SelectAgentInput Construction

Called in `selecting` state to decide which agent should work next.

**Algorithm**:

```typescript
function constructSelectAgentInput(
  context: RawkoContext
): SelectAgentInput {
  // 1. Task is always the original user task
  const task = context.task;

  // 2. Include current plan (null if not yet created)
  const plan = context.plan;

  // 3. Build execution history summary
  const history = buildExecutionHistory(
    context.history,
    {
      maxEntries: 10,           // Last 10 executions
      includeOutput: true,      // Include output summaries
      summarizeFailures: true,  // Focus on errors
    }
  );

  // 4. Construct error context (if there is an error)
  const lastError = context.lastError
    ? buildErrorContext(context.lastError, context)
    : null;

  // 5. Build agent descriptions for selection
  const availableAgents = Array.from(context.agents.values())
    .map(agent => ({
      name: agent.name,
      displayName: agent.displayName || agent.name,
      whenToUse: agent.whenToUse,
      tools: agent.tools,
    }));

  // 6. Constraints and progress metrics
  const constraints = {
    maxIterations: context.maxIterations,
    currentIteration: context.iterationCount,
    consecutiveFailures: context.consecutiveFailures,
    maxConsecutiveFailures: 3, // From config
  };

  return {
    task,
    plan,
    history,
    lastError,
    availableAgents,
    constraints,
  };
}
```

#### EvaluateProgressInput Construction

Called in `evaluating` state to assess whether task should continue, complete, or retry.

**Algorithm**:

```typescript
function constructEvaluateProgressInput(
  context: RawkoContext
): EvaluateProgressInput {
  // 1. Original task
  const task = context.task;

  // 2. Plan status
  const plan = context.plan;

  // 3. Last execution result (with full details for evaluation)
  const lastExecution = buildExecutionSummary(
    context.history[context.history.length - 1],
    {
      includeFullOutput: true,  // For evaluation, include full output
      includeErrors: true,
      includeTokens: true,
    }
  );

  // 4. Recent history for pattern recognition
  const history = buildExecutionHistory(
    context.history,
    {
      maxEntries: 5,            // Last 5 for pattern detection
      includeOutput: true,
      summarizeFailures: true,
    }
  );

  // 5. Constraints
  const constraints = {
    maxIterations: context.maxIterations,
    currentIteration: context.iterationCount,
    consecutiveFailures: context.consecutiveFailures,
    maxConsecutiveFailures: 3,
  };

  return {
    task,
    plan,
    lastExecution,
    history,
    constraints,
  };
}
```

### Data Selection and Formatting Rules

#### ExecutionSummary Format

Concise representation of agent execution:

```typescript
interface ExecutionSummary {
  agent: string;                // Agent name (e.g., "developer")
  iteration: number;            // Iteration count
  status: "success" | "failure" | "timeout" | "cancelled";
  duration_ms: number;          // How long agent worked

  // Execution details
  output?: {
    summary: string;            // First 500 characters
    full?: string;              // Full output (only for evaluation, not selection)
    filesModified?: string[];   // Files changed
  };

  // Error information (if failed)
  error?: {
    message: string;            // Error message
    category: string;           // tool | provider | agent | timeout
    step?: number;              // Plan step (if applicable)
    tool?: string;              // Tool involved (if applicable)
    recoveryOptions?: string[]; // Suggested next steps
  };

  // Resource usage
  tokens?: {
    input: number;
    output: number;
    total: number;
  };

  // Time context
  startedAt: string;            // ISO timestamp
  completedAt: string;          // ISO timestamp
}
```

**Formatting Rules**:

1. **Output Truncation**:
   - For `SelectAgentInput`: First 300 characters + "..." if longer
   - For `EvaluateProgressInput`: Full output (up to 2000 chars)
   - Include key information: files modified, steps completed, errors

2. **Error Summarization**:
   - Always include error message
   - Include category and tool (if applicable)
   - Suggest recovery options for arbiter
   - Example:
     ```
     tool: Bash
     message: "Command not found: npm install"
     category: "tool_failure"
     recoveryOptions: [
       "Check if npm is installed",
       "Try with full path",
       "Skip this step"
     ]
     ```

3. **History Inclusion**:
   - **For Selection**: Last 10 executions
   - **For Evaluation**: Last 5 executions
   - **Rationale**: Enough for pattern detection, not overwhelming
   - **Exception**: If agent is failing repeatedly, include more history

#### ErrorContext Format

Rich error information for arbiter reasoning:

```typescript
interface ErrorContext {
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
  category:
    | "tool_failure"      // Tool threw error
    | "provider_error"    // LLM API error
    | "validation_error"  // Invalid input
    | "timeout"           // Operation timed out
    | "permission_error"  // Access denied
    | "unknown";

  /** Recovery strategies arbiter can choose */
  recoveryOptions: {
    action: "retry" | "skip" | "fallback" | "abort";
    description: string;
    reason: string;
  }[];

  /** When the error occurred */
  timestamp: string;

  /** Context about what was happening */
  context: {
    filesAccessed?: string[];
    commandExecuted?: string;
    inputSize?: number;
    outputSize?: number;
  };
}
```

**Construction Rules**:

```typescript
function buildErrorContext(
  error: Error,
  context: RawkoContext
): ErrorContext {
  const agent = context.currentMode;
  const planStep = context.plan?.currentStepIndex;

  // Categorize error
  const category = categorizeError(error);

  // Build recovery options based on category
  const recoveryOptions = buildRecoveryOptions(category, context);

  return {
    agent,
    tool: extractToolFromError(error),
    planStep,
    attempted: buildAttemptedDescription(context),
    message: error.message,
    category,
    recoveryOptions,
    timestamp: new Date().toISOString(),
    context: extractErrorContext(error),
  };
}

function buildRecoveryOptions(
  category: string,
  context: RawkoContext
): ErrorContext["recoveryOptions"] {
  const options: ErrorContext["recoveryOptions"] = [];

  switch (category) {
    case "tool_failure":
      options.push({
        action: "retry",
        description: "Retry the same tool with different parameters",
        reason: "Tool may be in temporary error state",
      });
      options.push({
        action: "skip",
        description: "Skip this step and proceed to next",
        reason: "Step may not be critical to task",
      });
      break;

    case "provider_error":
      if (error.message.includes("rate_limit")) {
        options.push({
          action: "retry",
          description: "Wait and retry (rate limit should clear)",
          reason: "Rate limit is temporary",
        });
      }
      break;

    case "timeout":
      options.push({
        action: "abort",
        description: "Abort task due to timeout",
        reason: "Agent not making progress",
      });
      break;
  }

  // Always offer fallback
  options.push({
    action: "fallback",
    description: "Switch to different agent",
    reason: "Different agent may have better approach",
  });

  return options;
}
```

#### ConstraintContext Format

Current limits and progress:

```typescript
interface ConstraintContext {
  maxIterations: number;         // Total allowed
  currentIteration: number;      // Current count
  iterationsRemaining: number;   // Calculated
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  estimatedTokensUsed: number;
  timeElapsedMs: number;
  estimatedTimeRemaining: number;
}
```

#### AgentDescription Format

Rich description for selection:

```typescript
interface AgentDescription {
  name: string;                  // Internal name (planner, developer, etc)
  displayName: string;           // Human readable
  whenToUse: string;             // From agent config
  tools: {
    allowed?: string[];
    blocked?: string[];
  };
  recentPerformance?: {
    lastSuccess?: string;        // ISO timestamp
    lastFailure?: string;        // ISO timestamp
    successRate: number;         // 0-100
    iterationAverage: number;    // Avg iterations to succeed
  };
}
```

### History Building

```typescript
interface HistoryBuildOptions {
  maxEntries: number;
  includeOutput: boolean;
  summarizeFailures: boolean;
  includeTokens: boolean;
}

function buildExecutionHistory(
  fullHistory: ExecutionEntry[],
  options: HistoryBuildOptions
): ExecutionSummary[] {
  // 1. Select relevant entries
  let entries = fullHistory.slice(-options.maxEntries);

  // 2. If many failures, include more context
  const failureCount = entries.filter(e => e.result === "failure").length;
  if (failureCount > 2 && options.summarizeFailures) {
    // Include older failures for pattern recognition
    entries = [
      ...fullHistory.filter(e => e.result === "failure").slice(-5),
      ...entries.filter(e => e.result !== "failure"),
    ];
  }

  // 3. Format each entry
  return entries.map((entry, idx) => ({
    agent: entry.agent,
    iteration: fullHistory.indexOf(entry) + 1,
    status: entry.result,
    duration_ms: entry.completedAt
      ? entry.completedAt.getTime() - entry.startedAt.getTime()
      : 0,

    output: options.includeOutput && entry.output
      ? {
          summary: truncateOutput(entry.output, 300),
          filesModified: extractFilesFromOutput(entry.output),
        }
      : undefined,

    error: entry.error
      ? {
          message: entry.error,
          category: "unknown",
          recoveryOptions: [],
        }
      : undefined,

    tokens: options.includeTokens ? entry.tokenUsage : undefined,

    startedAt: entry.startedAt.toISOString(),
    completedAt: entry.completedAt?.toISOString(),
  }));
}
```

### Prompt Template Integration

How inputs are formatted into the arbiter LLM prompt:

```typescript
function buildArbiterPrompt(
  input: SelectAgentInput,
  promptTemplate: string
): string {
  const formattedAgents = input.availableAgents
    .map(
      a => `- **${a.displayName}** (${a.name})
    When to use: ${a.whenToUse}`
    )
    .join("\n\n");

  const formattedHistory = input.history
    .map(
      h => `- **${h.agent}** (iteration ${h.iteration}): ${h.status}
    Output: ${h.output?.summary || "N/A"}
    Duration: ${h.duration_ms}ms`
    )
    .join("\n\n");

  const formattedError = input.lastError
    ? `**Error**: ${input.lastError.message}
   Category: ${input.lastError.category}
   Agent: ${input.lastError.agent}
   Recovery options:
   ${input.lastError.recoveryOptions.map(o => `- ${o.action}: ${o.description}`).join("\n   ")}`
    : "No recent errors";

  const formattedPlan = input.plan
    ? `**Plan Progress**: Step ${input.plan.currentStepIndex} of ${input.plan.steps.length}
   Current: ${input.plan.steps[input.plan.currentStepIndex]?.description || "N/A"}`
    : "No plan yet";

  return promptTemplate
    .replace("{task}", input.task)
    .replace("{agents}", formattedAgents)
    .replace("{history}", formattedHistory)
    .replace("{error}", formattedError)
    .replace("{plan}", formattedPlan)
    .replace("{iteration}", String(input.constraints.currentIteration))
    .replace("{maxIterations}", String(input.constraints.maxIterations));
}
```

### Integration with XState Machine

How construction fits into state transitions:

```typescript
// In `selecting` state definition:
selecting: {
  invoke: {
    id: "selectAgent",
    src: "arbiterSelectAgent",
    input: ({ context }) => {
      // CONSTRUCT INPUT HERE
      return constructSelectAgentInput(context);
    },
    onDone: {
      target: "executing",
      actions: assign({
        currentAgent: ({ event }) => event.output.agent,
        lastArbiterDecision: ({ event }) => event.output.decision,
      }),
    },
    onError: {
      target: "error_handling",
      actions: assign({
        lastError: ({ event }) => event.error,
      }),
    },
  },
},

// In `evaluating` state definition:
evaluating: {
  invoke: {
    id: "evaluateProgress",
    src: "arbiterEvaluate",
    input: ({ context }) => {
      // CONSTRUCT INPUT HERE
      return constructEvaluateProgressInput(context);
    },
    onDone: [
      {
        guard: "isComplete",
        target: "complete",
      },
      {
        guard: "needsRetry",
        target: "selecting",
      },
      {
        target: "executing",
      },
    ],
  },
},
```

## Examples

### Example 1: Planning Phase

**Context**:
- Task: "Implement user authentication"
- First iteration, no plan yet
- No history

**Constructed SelectAgentInput**:

```json
{
  "task": "Implement user authentication",
  "plan": null,
  "history": [],
  "lastError": null,
  "availableAgents": [
    {
      "name": "planner",
      "displayName": "Planning Agent",
      "whenToUse": "Use this agent when starting a new task that needs analysis..."
    },
    {
      "name": "developer",
      "displayName": "Development Agent",
      "whenToUse": "Use when code modifications are required..."
    }
  ],
  "constraints": {
    "maxIterations": 50,
    "currentIteration": 1,
    "iterationsRemaining": 49,
    "consecutiveFailures": 0,
    "maxConsecutiveFailures": 3
  }
}
```

**Arbiter's Decision**: SELECT_MODE → planner (because no plan exists)

### Example 2: Mid-Execution with Error

**Context**:
- Task: "Implement user authentication"
- Iteration 4, plan exists with 5 steps
- Developer failed on step 2 with tool error

**Constructed SelectAgentInput**:

```json
{
  "task": "Implement user authentication",
  "plan": {
    "steps": [
      {
        "index": 1,
        "description": "Create middleware",
        "status": "complete"
      },
      {
        "index": 2,
        "description": "Login endpoint",
        "status": "failed"
      }
    ],
    "currentStepIndex": 1,
    "isComplete": false
  },
  "history": [
    {
      "agent": "planner",
      "iteration": 1,
      "status": "success",
      "duration_ms": 45000,
      "output": {
        "summary": "Analysis complete. Created 5-step plan..."
      }
    },
    {
      "agent": "developer",
      "iteration": 2,
      "status": "success",
      "duration_ms": 90000,
      "output": {
        "summary": "Middleware created successfully..."
      }
    },
    {
      "agent": "developer",
      "iteration": 3,
      "status": "failure",
      "output": {
        "summary": "Failed at import statement..."
      },
      "error": {
        "message": "Cannot find module 'jsonwebtoken'",
        "category": "tool_failure"
      }
    }
  ],
  "lastError": {
    "agent": "developer",
    "tool": "Bash",
    "planStep": 2,
    "attempted": "npm install jsonwebtoken",
    "message": "Command failed with exit code 1",
    "category": "tool_failure",
    "recoveryOptions": [
      {
        "action": "retry",
        "description": "Retry npm install",
        "reason": "Transient network error"
      },
      {
        "action": "skip",
        "description": "Skip install, use existing deps",
        "reason": "Package may already be available"
      }
    ]
  },
  "constraints": {
    "maxIterations": 50,
    "currentIteration": 4,
    "iterationsRemaining": 46,
    "consecutiveFailures": 1,
    "maxConsecutiveFailures": 3
  }
}
```

**Arbiter's Decision**: RETRY → "Let developer retry with package manager repair"

### Example 3: Evaluation Phase

**Context**: Developer just completed step 2 successfully

**Constructed EvaluateProgressInput**:

```json
{
  "task": "Implement user authentication",
  "plan": {
    "currentStepIndex": 2,
    "isComplete": false
  },
  "lastExecution": {
    "agent": "developer",
    "status": "success",
    "output": {
      "summary": "Login endpoint implemented. Created src/auth/login.ts with POST /login...",
      "filesModified": ["src/auth/login.ts"]
    },
    "tokens": {
      "input": 2100,
      "output": 1230,
      "total": 3330
    }
  },
  "history": [
    {
      "agent": "developer",
      "iteration": 2,
      "status": "success"
    },
    {
      "agent": "developer",
      "iteration": 3,
      "status": "failure"
    },
    {
      "agent": "developer",
      "iteration": 4,
      "status": "success"
    }
  ],
  "constraints": {
    "maxIterations": 50,
    "currentIteration": 5,
    "iterationsRemaining": 45
  }
}
```

**Arbiter's Decision**: CONTINUE → "Progress good, stay with developer for next steps"

## Drawbacks

1. **Token overhead** - Rich context increases LLM input costs
2. **Complexity** - Multiple formatting rules are hard to maintain
3. **Information loss** - Truncation loses context for debugging
4. **Prompt fragility** - Template-based prompts are brittle
5. **Testing difficulty** - Mocking construction is complex

## Unresolved Questions

1. **Adaptive context** - Should richness vary by agent type?
2. **Learned patterns** - Should we learn which context fields matter most?
3. **Caching** - Cache constructed inputs for repeated decisions?
4. **Structured output** - Use JSON schema instead of templates?
5. **Feedback loop** - Can we improve inputs based on decision quality?
