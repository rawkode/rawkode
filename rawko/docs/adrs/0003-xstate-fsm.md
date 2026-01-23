# ADR-0003: XState for FSM

## Status

Accepted (2026-01-23)

## Context

rawko-sdk requires a robust finite state machine (FSM) implementation to manage:

- Agent mode transitions (planning → development → testing → review)
- Task lifecycle (idle → executing → evaluating → complete)
- Error handling and recovery states
- Concurrent agent operations

The original Rust rawko used the `statig` crate for FSM. For the TypeScript rewrite, we need an equivalent that provides:

- Strong TypeScript support
- Async operation handling
- Visual debugging tools
- Battle-tested reliability
- Active maintenance

## Decision

Use **XState v5** as the state machine library for rawko-sdk.

### Key Capabilities

1. **Industry standard** - Most widely used TypeScript state machine library
2. **Excellent Deno compatibility** - Works via `npm:xstate@5` specifier
3. **Visual tooling** - XState Visualizer and Stately Studio for design/debugging
4. **Actor model** - Built-in support for spawning isolated actors (agents)
5. **Type inference** - Strong TypeScript types with `setup()` and `createMachine()`
6. **Comprehensive features** - Guards, actions, services, parallel states, history

### Basic Example

```typescript
import { setup, createActor } from "npm:xstate@5";

const rawkoMachine = setup({
  types: {
    context: {} as RawkoContext,
    events: {} as RawkoEvent,
  },
  actors: {
    executeAgent: fromPromise(async ({ input }) => {
      // Agent execution logic
    }),
  },
  guards: {
    hasMoreWork: ({ context }) => !context.plan.isComplete,
    maxRetriesExceeded: ({ context }) => context.failures >= 3,
  },
}).createMachine({
  id: "rawko",
  initial: "idle",
  states: {
    idle: { /* ... */ },
    planning: { /* ... */ },
    executing: { /* ... */ },
    // States loaded from .rawko/agents/
  },
});
```

## Consequences

### Positive

- **Proven reliability** - Battle-tested in production at major companies
- **Visual debugging** - Stately Studio shows state diagrams and transition traces
- **Type safety** - Full TypeScript inference for events, context, and actions
- **Actor isolation** - Each agent runs as an isolated actor with its own state
- **Testability** - Built-in testing utilities (`createTestActor`)
- **Serialization** - State can be persisted and restored for session resumption
- **Community** - Large ecosystem, extensive documentation, active Discord

### Negative

- **Learning curve** - XState v5's actor model differs from simpler FSM libraries
- **Bundle size** - XState is larger than minimal FSM implementations
- **Abstraction overhead** - Some concepts (actors, invocations) add complexity
- **Migration** - v4 to v5 changes may affect future upgrades

## Alternatives Considered

### Custom Implementation

**Approach**: Build a minimal FSM tailored to rawko's needs

**Pros**: Minimal dependencies, exact feature set needed
**Cons**: Maintenance burden, missing advanced features, no visual tools

**Rejected because**: Building and maintaining a quality FSM is non-trivial; XState provides more features than we'd reasonably implement.

### Robot (robot3)

**Approach**: Lightweight FSM library with functional API

**Pros**: Smaller bundle, simpler API
**Cons**: Less mature, fewer features, no actor model, limited TypeScript support

**Rejected because**: Lacks actor model needed for agent isolation; less comprehensive TypeScript support.

### Zustand + Custom Logic

**Approach**: State management library with hand-coded transitions

**Pros**: Familiar to React developers, very flexible
**Cons**: Not a real FSM, no transition validation, easy to create invalid states

**Rejected because**: State machines provide guarantees that ad-hoc state management cannot.

### Effect/TS (formerly fp-ts)

**Approach**: Functional programming approach to state management

**Pros**: Powerful type system, excellent error handling
**Cons**: Steep learning curve, not FSM-focused, complex syntax

**Rejected because**: Overkill for FSM needs; XState's simpler model is sufficient.

## Implementation Notes

### Machine Structure

The XState machine is structured with dynamic states loaded from agent configurations:

```typescript
// States are generated from .rawko/agents/*.yaml
const states = await loadAgentStates(".rawko/agents/");

const machine = setup({
  // Type definitions
}).createMachine({
  id: "rawko",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: {
        START_TASK: "selecting",
      },
    },
    selecting: {
      // Arbiter selects next agent
      invoke: {
        src: "selectAgent",
        onDone: {
          target: "executing",
          actions: "setCurrentAgent",
        },
      },
    },
    executing: {
      // Dynamic child machine based on current agent
      invoke: {
        src: "executeAgent",
        input: ({ context }) => context.currentAgent,
        onDone: "evaluating",
        onError: "handling_error",
      },
    },
    evaluating: {
      // Arbiter evaluates progress
      invoke: {
        src: "evaluateProgress",
        onDone: [
          { guard: "isComplete", target: "complete" },
          { guard: "needsRetry", target: "selecting" },
          { target: "executing" },
        ],
      },
    },
    handling_error: {
      // Error recovery logic
    },
    complete: {
      type: "final",
    },
    // Additional states from agent configs...
  },
});
```

### Actor Model for Agents

Each agent runs as an isolated XState actor:

```typescript
import { fromPromise, assign } from "npm:xstate@5";

const executeAgent = fromPromise(async ({ input, system }) => {
  const { agent, session, context } = input;

  // Stream agent execution
  for await (const event of session.sendMessage({
    role: "user",
    content: context.currentTask,
  })) {
    // Handle streaming events
    system.emit({ type: "AGENT_EVENT", event });
  }

  return { result: "success", output: "..." };
});
```

### Context Schema

```typescript
interface RawkoContext {
  // Task information
  task: {
    description: string;
    startedAt: Date;
  };

  // Current execution state
  currentAgent: AgentConfig | null;
  currentMode: string;

  // Plan created by planning agent
  plan: {
    steps: PlanStep[];
    currentStepIndex: number;
    isComplete: boolean;
  };

  // Execution history
  history: ExecutionHistoryEntry[];

  // Error tracking
  failures: number;
  lastError: Error | null;

  // Provider session
  session: ProviderSession | null;
}
```

### Event Types

```typescript
type RawkoEvent =
  | { type: "START_TASK"; task: string }
  | { type: "AGENT_SELECTED"; agent: AgentConfig }
  | { type: "AGENT_COMPLETE"; result: AgentResult }
  | { type: "AGENT_ERROR"; error: Error }
  | { type: "ARBITER_DECISION"; decision: ArbiterDecision }
  | { type: "CANCEL" }
  | { type: "RETRY" };
```

### Visual Debugging

XState machines can be visualized using Stately Studio:

```typescript
// Enable inspector in development
import { createBrowserInspector } from "@stately/inspect";

const inspector = createBrowserInspector();

const actor = createActor(rawkoMachine, {
  inspect: inspector.inspect,
});
```

### Testing

```typescript
import { createTestActor } from "npm:xstate@5";

Deno.test("transitions from idle to planning on START_TASK", () => {
  const actor = createTestActor(rawkoMachine);
  actor.start();

  actor.send({ type: "START_TASK", task: "implement feature" });

  expect(actor.getSnapshot().value).toBe("selecting");
});
```

See [SPEC-0003: XState Machine Definition](../specs/0003-xstate-machine.md) for complete machine specification.
