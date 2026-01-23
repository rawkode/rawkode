# SPEC-0003: XState Machine Definition

## Abstract

This specification defines the XState v5 machine configuration for rawko-sdk, including state definitions, context schema, event types, guards, actions, and actor invocations.

## Motivation

The state machine is the core orchestration component of rawko-sdk. A well-defined machine ensures:

- Predictable agent transitions
- Clear error handling paths
- Serializable state for session persistence
- Visual debugging capabilities
- Type-safe event handling

## Detailed Design

### Machine Overview

```
                    ┌─────────────────────────────────────────────────┐
                    │                    rawko                         │
                    │                                                  │
    START_TASK      │  ┌──────┐    ┌───────────┐    ┌───────────┐    │
   ───────────────▶ │  │ idle │───▶│ selecting │───▶│ executing │    │
                    │  └──────┘    └───────────┘    └─────┬─────┘    │
                    │       ▲                             │          │
                    │       │                             ▼          │
                    │       │         ┌───────────┐  ┌──────────┐   │
                    │       │         │  error    │◀─│evaluating│   │
                    │       │         │ handling  │  └────┬─────┘   │
                    │       │         └─────┬─────┘       │         │
                    │       │               │             │         │
                    │       │               ▼             ▼         │
                    │       │         ┌──────────┐  ┌──────────┐   │
                    │       └─────────│ complete │◀─│ continue │   │
                    │                 └──────────┘  └──────────┘   │
                    └─────────────────────────────────────────────────┘
```

### Machine ID and Initial State

```typescript
const rawkoMachine = setup({
  // ... type definitions
}).createMachine({
  id: "rawko",
  initial: "idle",
  context: ({ input }) => ({
    ...initialContext,
    ...input,
  }),
  // ... states
});
```

### Context Schema

```typescript
/**
 * Complete context type for the rawko state machine.
 */
interface RawkoContext {
  // === Task Information ===
  /** The user's original task description */
  task: string;

  /** When the task was started */
  startedAt: Date | null;

  // === Agent State ===
  /** Currently active agent configuration */
  currentAgent: AgentConfig | null;

  /** Name of the current mode/agent */
  currentMode: string;

  /** All loaded agent configurations */
  agents: Map<string, AgentConfig>;

  // === Planning ===
  /** Plan created by planning agent */
  plan: Plan | null;

  // === Execution History ===
  /** History of agent executions */
  history: ExecutionEntry[];

  /** Messages in current agent conversation */
  messages: Message[];

  // === Error Tracking ===
  /** Consecutive failure count */
  consecutiveFailures: number;

  /** Total failures across all agents */
  totalFailures: number;

  /** Last error encountered */
  lastError: Error | null;

  // === Provider State ===
  /** Active provider session */
  session: ProviderSession | null;

  /** Provider name being used */
  providerName: string;

  // === Arbiter State ===
  /** Last arbiter decision */
  lastArbiterDecision: ArbiterDecision | null;

  // === Constraints ===
  /** Maximum total iterations */
  maxIterations: number;

  /** Current iteration count */
  iterationCount: number;
}

interface Plan {
  steps: PlanStep[];
  currentStepIndex: number;
  isComplete: boolean;
}

interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed";
  agentUsed?: string;
}

interface ExecutionEntry {
  agent: string;
  startedAt: Date;
  completedAt: Date | null;
  result: "success" | "failure" | "cancelled";
  output?: string;
  error?: string;
  tokenUsage?: TokenUsage;
}
```

### Event Types

```typescript
/**
 * All events the rawko machine can receive.
 */
type RawkoEvent =
  // === Lifecycle Events ===
  | { type: "START_TASK"; task: string }
  | { type: "CANCEL" }
  | { type: "RESET" }

  // === Agent Selection Events ===
  | { type: "AGENT_SELECTED"; agent: AgentConfig }
  | { type: "AGENT_SELECTION_FAILED"; error: Error }

  // === Execution Events ===
  | { type: "AGENT_MESSAGE"; message: Message }
  | { type: "AGENT_TOOL_CALL"; toolCall: ToolCall }
  | { type: "AGENT_TOOL_RESULT"; toolResult: ToolResult }
  | { type: "AGENT_COMPLETE"; result: AgentResult }
  | { type: "AGENT_ERROR"; error: Error }

  // === Arbiter Events ===
  | { type: "ARBITER_DECISION"; decision: ArbiterDecision }
  | { type: "ARBITER_ERROR"; error: Error }

  // === Manual Overrides ===
  | { type: "FORCE_AGENT"; agentName: string }
  | { type: "SKIP_STEP" }
  | { type: "RETRY" };

interface AgentResult {
  success: boolean;
  output: string;
  planUpdates?: Partial<Plan>;
}

type ArbiterDecision =
  | { type: "SELECT_MODE"; mode: string; reason: string }
  | { type: "CONTINUE"; reason: string }
  | { type: "COMPLETE"; summary: string }
  | { type: "RETRY"; reason: string };
```

### State Definitions

#### Idle State

```typescript
idle: {
  description: "Waiting for a task to begin",
  on: {
    START_TASK: {
      target: "selecting",
      actions: [
        assign({
          task: ({ event }) => event.task,
          startedAt: () => new Date(),
          iterationCount: 0,
          consecutiveFailures: 0,
        }),
        "logTaskStart",
      ],
    },
  },
},
```

#### Selecting State

```typescript
selecting: {
  description: "Arbiter is selecting the next agent",
  invoke: {
    id: "selectAgent",
    src: "arbiterSelectAgent",
    input: ({ context }) => ({
      task: context.task,
      plan: context.plan,
      history: context.history,
      lastError: context.lastError,
      agents: context.agents,
    }),
    onDone: {
      target: "executing",
      actions: assign({
        currentAgent: ({ event }) => event.output.agent,
        currentMode: ({ event }) => event.output.agent.name,
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
```

#### Executing State

```typescript
executing: {
  description: "An agent is actively working",
  entry: [
    assign({ iterationCount: ({ context }) => context.iterationCount + 1 }),
    "logAgentStart",
  ],
  invoke: {
    id: "executeAgent",
    src: "agentExecutor",
    input: ({ context }) => ({
      agent: context.currentAgent,
      session: context.session,
      task: context.task,
      plan: context.plan,
      messages: context.messages,
    }),
    onDone: {
      target: "evaluating",
      actions: [
        assign({
          messages: ({ context, event }) => [
            ...context.messages,
            ...event.output.messages,
          ],
          plan: ({ context, event }) =>
            event.output.planUpdates
              ? { ...context.plan, ...event.output.planUpdates }
              : context.plan,
          consecutiveFailures: 0,
        }),
        "recordExecution",
        "logAgentComplete",
      ],
    },
    onError: {
      target: "error_handling",
      actions: [
        assign({
          lastError: ({ event }) => event.error,
          consecutiveFailures: ({ context }) => context.consecutiveFailures + 1,
          totalFailures: ({ context }) => context.totalFailures + 1,
        }),
        "recordFailure",
        "logAgentError",
      ],
    },
  },
  on: {
    AGENT_MESSAGE: {
      actions: "streamMessage",
    },
    AGENT_TOOL_CALL: {
      actions: "logToolCall",
    },
    CANCEL: {
      target: "cancelled",
    },
  },
},
```

#### Evaluating State

```typescript
evaluating: {
  description: "Arbiter is evaluating progress and deciding next steps",
  invoke: {
    id: "evaluateProgress",
    src: "arbiterEvaluate",
    input: ({ context }) => ({
      task: context.task,
      plan: context.plan,
      history: context.history,
      lastExecution: context.history[context.history.length - 1],
    }),
    onDone: [
      {
        guard: "isComplete",
        target: "complete",
        actions: assign({
          lastArbiterDecision: ({ event }) => event.output,
        }),
      },
      {
        guard: "shouldRetry",
        target: "selecting",
        actions: assign({
          lastArbiterDecision: ({ event }) => event.output,
        }),
      },
      {
        guard: "maxIterationsReached",
        target: "complete",
        actions: [
          assign({ lastArbiterDecision: () => ({ type: "COMPLETE", summary: "Max iterations reached" }) }),
          "logMaxIterations",
        ],
      },
      {
        target: "selecting",
        actions: assign({
          lastArbiterDecision: ({ event }) => event.output,
        }),
      },
    ],
    onError: {
      target: "error_handling",
      actions: assign({
        lastError: ({ event }) => event.error,
      }),
    },
  },
},
```

#### Error Handling State

```typescript
error_handling: {
  description: "Handling an error that occurred during execution",
  always: [
    {
      guard: "maxFailuresReached",
      target: "failed",
      actions: "logMaxFailures",
    },
    {
      guard: "isRecoverableError",
      target: "selecting",
      actions: "logRecovery",
    },
    {
      target: "failed",
    },
  ],
},
```

#### Terminal States

```typescript
complete: {
  type: "final",
  description: "Task completed successfully",
  entry: ["logCompletion", "cleanupSession"],
},

failed: {
  type: "final",
  description: "Task failed after maximum retries",
  entry: ["logFailure", "cleanupSession"],
},

cancelled: {
  type: "final",
  description: "Task was cancelled by user",
  entry: ["logCancellation", "cleanupSession"],
},
```

### Guards

```typescript
const guards = {
  isComplete: ({ event }) =>
    event.output?.type === "COMPLETE",

  shouldRetry: ({ event }) =>
    event.output?.type === "RETRY",

  maxIterationsReached: ({ context }) =>
    context.iterationCount >= context.maxIterations,

  maxFailuresReached: ({ context }) =>
    context.consecutiveFailures >= 3,

  isRecoverableError: ({ context }) => {
    const error = context.lastError;
    if (!error) return false;

    // Rate limits and transient errors are recoverable
    if (error instanceof ProviderError) {
      return ["rate_limited", "network_error"].includes(error.code);
    }
    return false;
  },

  hasAgent: ({ context }, params: { name: string }) =>
    context.agents.has(params.name),
};
```

### Actions

```typescript
const actions = {
  logTaskStart: ({ context }) => {
    console.log(`[rawko] Starting task: ${context.task}`);
  },

  logAgentStart: ({ context }) => {
    console.log(`[rawko] Agent '${context.currentMode}' starting (iteration ${context.iterationCount})`);
  },

  logAgentComplete: ({ context }) => {
    console.log(`[rawko] Agent '${context.currentMode}' completed`);
  },

  logAgentError: ({ context }) => {
    console.error(`[rawko] Agent '${context.currentMode}' error:`, context.lastError?.message);
  },

  streamMessage: ({ event }) => {
    // Real-time output of agent messages
    if (event.message.role === "assistant") {
      process.stdout.write(event.message.content);
    }
  },

  logToolCall: ({ event }) => {
    console.log(`[rawko] Tool call: ${event.toolCall.name}`);
  },

  recordExecution: assign({
    history: ({ context, event }) => [
      ...context.history,
      {
        agent: context.currentMode,
        startedAt: new Date(), // Should track actual start
        completedAt: new Date(),
        result: "success" as const,
        output: event.output.summary,
        tokenUsage: event.output.usage,
      },
    ],
  }),

  recordFailure: assign({
    history: ({ context }) => [
      ...context.history,
      {
        agent: context.currentMode,
        startedAt: new Date(),
        completedAt: new Date(),
        result: "failure" as const,
        error: context.lastError?.message,
      },
    ],
  }),

  cleanupSession: async ({ context }) => {
    if (context.session) {
      await context.session.close();
    }
  },

  logCompletion: ({ context }) => {
    console.log(`[rawko] Task completed in ${context.iterationCount} iterations`);
  },

  logFailure: ({ context }) => {
    console.error(`[rawko] Task failed after ${context.totalFailures} failures`);
  },

  logCancellation: () => {
    console.log(`[rawko] Task cancelled`);
  },

  logMaxIterations: ({ context }) => {
    console.warn(`[rawko] Max iterations (${context.maxIterations}) reached`);
  },

  logMaxFailures: ({ context }) => {
    console.error(`[rawko] Max consecutive failures (${context.consecutiveFailures}) reached`);
  },

  logRecovery: ({ context }) => {
    console.log(`[rawko] Recovering from error: ${context.lastError?.message}`);
  },
};
```

### Actors (Invoked Services)

```typescript
import { fromPromise } from "npm:xstate@5";

const actors = {
  /**
   * Arbiter service that selects the next agent.
   */
  arbiterSelectAgent: fromPromise(async ({ input }) => {
    const { task, plan, history, lastError, agents } = input;

    const arbiter = new Arbiter(/* config */);
    const decision = await arbiter.selectAgent({
      task,
      plan,
      history,
      lastError,
      availableAgents: [...agents.values()],
    });

    const agent = agents.get(decision.mode);
    if (!agent) {
      throw new Error(`Arbiter selected unknown agent: ${decision.mode}`);
    }

    return { agent, decision };
  }),

  /**
   * Agent executor service.
   */
  agentExecutor: fromPromise(async ({ input, emit }) => {
    const { agent, session, task, plan, messages } = input;

    // Configure session with agent's tools and prompt
    session.setSystemPrompt(agent.systemPrompt);
    session.setTools(filterTools(agent.tools));

    const newMessages: Message[] = [];
    let iterations = 0;

    while (iterations < (agent.limits?.maxIterations ?? 10)) {
      const userMessage = iterations === 0
        ? buildInitialPrompt(task, plan)
        : buildContinuationPrompt(plan);

      for await (const event of session.sendMessage({
        role: "user",
        content: userMessage,
      })) {
        // Emit streaming events for real-time feedback
        if (event.type === "text_delta") {
          emit({ type: "AGENT_MESSAGE", message: { role: "assistant", content: event.delta } });
        }
        if (event.type === "tool_use_end") {
          emit({ type: "AGENT_TOOL_CALL", toolCall: { name: event.name, arguments: event.input } });
        }
        if (event.type === "message_done") {
          newMessages.push(event.message);

          if (event.stopReason === "end_turn") {
            return {
              messages: newMessages,
              summary: extractSummary(event.message),
              usage: event.usage,
            };
          }
        }
      }

      iterations++;
    }

    return {
      messages: newMessages,
      summary: "Max iterations reached",
    };
  }),

  /**
   * Arbiter service that evaluates progress.
   */
  arbiterEvaluate: fromPromise(async ({ input }) => {
    const { task, plan, history, lastExecution } = input;

    const arbiter = new Arbiter(/* config */);
    return arbiter.evaluateProgress({
      task,
      plan,
      history,
      lastExecution,
    });
  }),
};
```

### Complete Machine Definition

```typescript
import { setup, assign, fromPromise } from "npm:xstate@5";

export const rawkoMachine = setup({
  types: {
    context: {} as RawkoContext,
    events: {} as RawkoEvent,
    input: {} as Partial<RawkoContext>,
  },
  actors,
  guards,
  actions,
}).createMachine({
  id: "rawko",
  initial: "idle",
  context: ({ input }) => ({
    task: "",
    startedAt: null,
    currentAgent: null,
    currentMode: "",
    agents: input?.agents ?? new Map(),
    plan: null,
    history: [],
    messages: [],
    consecutiveFailures: 0,
    totalFailures: 0,
    lastError: null,
    session: null,
    providerName: input?.providerName ?? "claude",
    lastArbiterDecision: null,
    maxIterations: input?.maxIterations ?? 50,
    iterationCount: 0,
    ...input,
  }),
  states: {
    idle: { /* ... */ },
    selecting: { /* ... */ },
    executing: { /* ... */ },
    evaluating: { /* ... */ },
    error_handling: { /* ... */ },
    complete: { /* ... */ },
    failed: { /* ... */ },
    cancelled: { /* ... */ },
  },
});
```

## Examples

### Starting the Machine

```typescript
import { createActor } from "npm:xstate@5";

const agents = await loadAllAgents(".rawko/agents/");
const session = await provider.createSession({ model: "claude-sonnet-4" });

const actor = createActor(rawkoMachine, {
  input: {
    agents,
    session,
    providerName: "claude",
    maxIterations: 50,
  },
});

actor.subscribe((snapshot) => {
  console.log("State:", snapshot.value);
  console.log("Context:", snapshot.context);
});

actor.start();
actor.send({ type: "START_TASK", task: "Implement user authentication" });
```

### Persisting State

```typescript
// Save state for session resumption
const snapshot = actor.getPersistedSnapshot();
await Deno.writeTextFile("session.json", JSON.stringify(snapshot));

// Restore state
const savedSnapshot = JSON.parse(await Deno.readTextFile("session.json"));
const restoredActor = createActor(rawkoMachine, {
  snapshot: savedSnapshot,
});
restoredActor.start();
```

## Drawbacks

1. **Complexity** - XState's actor model adds learning curve
2. **Debugging** - Async actors can be difficult to trace
3. **Type inference** - Complex context types can slow IDE
4. **Testing** - Actor invocations require mocking

## Unresolved Questions

1. **Parallel agents** - Should we support running multiple agents simultaneously?
2. **Checkpointing** - How often to persist state for crash recovery?
3. **Streaming** - Best pattern for streaming agent output to UI?
4. **Cancellation** - How to gracefully cancel mid-tool-execution?
