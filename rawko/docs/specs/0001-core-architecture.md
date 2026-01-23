# SPEC-0001: Core Architecture

## Abstract

This specification defines the overall system architecture for rawko-sdk, including component interactions, execution flow, error handling, and integration points.

## Motivation

A clear architectural specification enables:

- Consistent implementation across components
- Understanding of data flow and dependencies
- Identification of extension points
- Alignment between documentation and code

## Detailed Design

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              rawko-sdk                                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         CLI / Driver                             │   │
│  │  - Parse arguments                                               │   │
│  │  - Load configuration                                            │   │
│  │  - Initialize providers                                          │   │
│  │  - Start XState machine                                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      XState Machine                              │   │
│  │                                                                  │   │
│  │   ┌──────┐    ┌───────────┐    ┌───────────┐    ┌──────────┐   │   │
│  │   │ idle │───▶│ selecting │───▶│ executing │───▶│evaluating│   │   │
│  │   └──────┘    └─────┬─────┘    └─────┬─────┘    └────┬─────┘   │   │
│  │                     │                │               │          │   │
│  │                     ▼                ▼               ▼          │   │
│  │              ┌──────────┐     ┌──────────┐    ┌──────────┐     │   │
│  │              │ Arbiter  │     │  Agent   │    │ Arbiter  │     │   │
│  │              │ (select) │     │ Executor │    │ (eval)   │     │   │
│  │              └──────────┘     └──────────┘    └──────────┘     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                    ┌───────────────┼───────────────┐                   │
│                    ▼               ▼               ▼                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │  Claude Provider │  │ Copilot Provider │  │   Tool Registry  │     │
│  │                  │  │                  │  │                  │     │
│  │  - createSession │  │  - createSession │  │  - Read, Write   │     │
│  │  - sendMessage   │  │  - sendMessage   │  │  - Edit, Glob    │     │
│  │  - setTools      │  │  - setTools      │  │  - Grep, Bash    │     │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘     │
│           │                     │                     │                │
└───────────┼─────────────────────┼─────────────────────┼────────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
    │ Anthropic API │    │  GitHub API   │    │  File System  │
    └───────────────┘    └───────────────┘    └───────────────┘
```

### Component Descriptions

#### CLI / Driver

The entry point for rawko-sdk that orchestrates startup and user interaction.

```typescript
// src/cli.ts
interface CLI {
  /** Parse command line arguments */
  parseArgs(args: string[]): CLIOptions;

  /** Load configuration from .rawko/ */
  loadConfig(options: CLIOptions): Promise<RawkoConfig>;

  /** Initialize and run the state machine */
  run(config: RawkoConfig, task: string): Promise<void>;
}

interface CLIOptions {
  configPath: string;
  task?: string;
  provider?: string;
  verbose: boolean;
  dryRun: boolean;
}
```

**Responsibilities**:
- Parse CLI arguments using `std/flags`
- Load `.rawko/config.yaml` and agent definitions
- Initialize provider instances
- Create and start XState actor
- Handle user input/interrupts
- Display output and progress

#### Configuration Loader

Loads and validates configuration files.

```typescript
// src/config/loader.ts
interface ConfigLoader {
  /** Load main configuration */
  loadConfig(path: string): Promise<RawkoConfig>;

  /** Load all agent definitions */
  loadAgents(directory: string): Promise<Map<string, AgentConfig>>;

  /** Watch for configuration changes */
  watch(callback: (config: RawkoConfig) => void): void;
}

interface RawkoConfig {
  version: string;
  provider: ProviderConfig;
  arbiter: ArbiterConfig;
  agents: AgentDirectoryConfig;
  constraints: ConstraintsConfig;
}
```

#### XState Machine

The core orchestration engine managing agent transitions.

See [SPEC-0003: XState Machine Definition](./0003-xstate-machine.md) for complete specification.

**Key Interactions**:
- Receives `START_TASK` event from CLI
- Invokes arbiter for agent selection
- Invokes agent executor for tool execution
- Emits events for progress tracking
- Persists state for session resumption

#### Arbiter

LLM-based decision maker for mode transitions.

See [ADR-0005: LLM-Based Arbiter](../adrs/0005-llm-arbiter.md) for design rationale.

```typescript
// src/arbiter/arbiter.ts
interface Arbiter {
  /** Select next agent based on task state */
  selectAgent(input: SelectAgentInput): Promise<ArbiterDecision>;

  /** Evaluate progress and decide next action */
  evaluateProgress(input: EvaluateProgressInput): Promise<ArbiterDecision>;
}
```

**Key Interactions**:
- Called by XState machine in `selecting` and `evaluating` states
- Uses its own provider session (can be different model)
- Returns structured decisions (SELECT_MODE, CONTINUE, COMPLETE, RETRY)

#### Agent Executor

Runs individual agents with their configured tools.

```typescript
// src/executor/executor.ts
interface AgentExecutor {
  /** Execute an agent until completion or iteration limit */
  execute(input: ExecutionInput): AsyncIterable<ExecutionEvent>;
}

interface ExecutionInput {
  agent: AgentConfig;
  session: ProviderSession;
  task: string;
  plan: Plan | null;
  messages: Message[];
}

type ExecutionEvent =
  | { type: "message"; content: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; output: string; isError: boolean }
  | { type: "complete"; result: AgentResult }
  | { type: "error"; error: Error };
```

**Key Interactions**:
- Configured with agent's system prompt and tools
- Streams events back to XState machine
- Handles tool execution via Tool Registry
- Respects iteration and timeout limits

#### Provider Layer

Abstracts LLM provider APIs behind unified interface.

See [SPEC-0002: Provider Interface](./0002-provider-interface.md) for complete specification.

**Key Interactions**:
- Instantiated by CLI based on configuration
- Used by both Arbiter and Agent Executor
- Manages conversation history and context

#### Tool Registry

Manages available tools and their filtering per agent.

See [ADR-0006: Mode-Based Tool Filtering](../adrs/0006-tool-filtering.md) for design rationale.

```typescript
// src/tools/registry.ts
interface ToolRegistry {
  /** All registered tools */
  readonly allTools: Map<string, ToolDefinition>;

  /** Get filtered tools for a specific agent */
  getToolsForAgent(agent: AgentConfig): ToolDefinition[];

  /** Execute a tool by name */
  executeTool(name: string, input: unknown): Promise<ToolResult>;
}
```

### Execution Flow

#### 1. Startup

```
User runs: rawko "implement feature X"
                    │
                    ▼
            ┌───────────────┐
            │ CLI.parseArgs │
            └───────┬───────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ ConfigLoader.load    │
         │ - .rawko/config.yaml │
         │ - .rawko/agents/*    │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ Provider.createSession│
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ createActor(machine) │
         │ actor.start()        │
         │ actor.send(START)    │
         └──────────────────────┘
```

#### 2. Agent Selection

```
        XState: "selecting" state
                    │
                    ▼
         ┌──────────────────────┐
         │ Arbiter.selectAgent  │
         │                      │
         │ Input:               │
         │  - task              │
         │  - plan              │
         │  - history           │
         │  - availableAgents   │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ LLM Decision         │
         │                      │
         │ "Based on the task,  │
         │  select 'planner'    │
         │  to create a plan"   │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ Return:              │
         │ { type: SELECT_MODE, │
         │   mode: "planner",   │
         │   reason: "..." }    │
         └──────────────────────┘
```

#### 3. Agent Execution

```
        XState: "executing" state
                    │
                    ▼
         ┌──────────────────────┐
         │ AgentExecutor.execute│
         └──────────┬───────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐      ┌───────────────┐
│ session.      │      │ ToolRegistry. │
│ setSystemPrompt│     │ getToolsFor   │
│ (agent.prompt)│      │ Agent(agent)  │
└───────┬───────┘      └───────┬───────┘
        │                      │
        └──────────┬───────────┘
                   │
                   ▼
         ┌──────────────────────┐
         │ session.sendMessage  │◀──────┐
         └──────────┬───────────┘       │
                    │                   │
                    ▼                   │
         ┌──────────────────────┐       │
         │ Stream Events:       │       │
         │ - text_delta         │       │
         │ - tool_use           │       │
         │ - message_done       │       │
         └──────────┬───────────┘       │
                    │                   │
            ┌───────┴───────┐           │
            │  tool_use?    │           │
            └───────┬───────┘           │
                    │ yes               │
                    ▼                   │
         ┌──────────────────────┐       │
         │ ToolRegistry.execute │       │
         │ (name, input)        │       │
         └──────────┬───────────┘       │
                    │                   │
                    ▼                   │
         ┌──────────────────────┐       │
         │ Send tool result     │───────┘
         └──────────────────────┘
```

#### 4. Progress Evaluation

```
        XState: "evaluating" state
                    │
                    ▼
         ┌──────────────────────┐
         │ Arbiter.evaluate     │
         │ Progress             │
         │                      │
         │ Input:               │
         │  - task              │
         │  - plan              │
         │  - lastExecution     │
         │  - history           │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ LLM Decision         │
         │                      │
         │ Options:             │
         │ - CONTINUE           │
         │ - COMPLETE           │
         │ - RETRY              │
         │ - SELECT_MODE        │
         └──────────┬───────────┘
                    │
        ┌───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼
    COMPLETE    CONTINUE    RETRY    SELECT_MODE
        │           │           │           │
        ▼           ▼           ▼           ▼
    "complete"  "executing" "selecting" "selecting"
      state       state       state       state
```

### Error Handling

#### Error Categories

```typescript
enum ErrorCategory {
  /** Provider API errors (rate limits, auth failures) */
  PROVIDER = "provider",

  /** Tool execution failures */
  TOOL = "tool",

  /** Configuration errors */
  CONFIG = "config",

  /** XState machine errors */
  MACHINE = "machine",

  /** User cancellation */
  CANCELLED = "cancelled",
}

interface RawkoError extends Error {
  category: ErrorCategory;
  recoverable: boolean;
  context?: Record<string, unknown>;
}
```

#### Recovery Strategies

| Error Type | Recoverable | Strategy |
|------------|-------------|----------|
| Rate limit | Yes | Exponential backoff, retry |
| Network error | Yes | Retry with backoff |
| Auth failure | No | Fail, prompt for credentials |
| Tool failure | Yes | Retry or skip via arbiter |
| Config error | No | Fail with clear message |
| Max iterations | No | Complete with warning |
| User cancel | No | Clean shutdown |

```typescript
// src/errors/recovery.ts
async function handleError(
  error: RawkoError,
  context: RawkoContext
): Promise<RecoveryAction> {
  if (!error.recoverable) {
    return { action: "fail", error };
  }

  switch (error.category) {
    case ErrorCategory.PROVIDER:
      if (error.message.includes("rate_limit")) {
        const delay = calculateBackoff(context.consecutiveFailures);
        return { action: "retry", delay };
      }
      break;

    case ErrorCategory.TOOL:
      // Let arbiter decide how to proceed
      return { action: "evaluate" };
  }

  return { action: "fail", error };
}
```

### Deno Permission Model

rawko-sdk requires specific Deno permissions:

```typescript
// src/permissions.ts
const REQUIRED_PERMISSIONS: Deno.PermissionDescriptor[] = [
  { name: "read", path: "." },           // Read project files
  { name: "write", path: "." },          // Write files (developer mode)
  { name: "net", host: "api.anthropic.com" },  // Claude API
  { name: "net", host: "api.github.com" },     // Copilot API
  { name: "env", variable: "ANTHROPIC_API_KEY" },
  { name: "env", variable: "GITHUB_TOKEN" },
  { name: "run", command: "bash" },      // Bash tool
];

async function checkPermissions(): Promise<PermissionStatus[]> {
  return Promise.all(
    REQUIRED_PERMISSIONS.map((desc) => Deno.permissions.query(desc))
  );
}

async function requestPermissions(): Promise<void> {
  for (const desc of REQUIRED_PERMISSIONS) {
    const status = await Deno.permissions.request(desc);
    if (status.state !== "granted") {
      throw new Error(`Permission denied: ${JSON.stringify(desc)}`);
    }
  }
}
```

**Running with permissions**:

```bash
# Explicit permissions
deno run \
  --allow-read=. \
  --allow-write=. \
  --allow-net=api.anthropic.com,api.github.com \
  --allow-env=ANTHROPIC_API_KEY,GITHUB_TOKEN \
  --allow-run=bash,git \
  mod.ts "implement feature"

# Or with permission prompt
deno run --prompt mod.ts "implement feature"
```

### Observability Integration

#### Logging

```typescript
// src/observability/logger.ts
interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

// Structured logging for machine events
function logMachineEvent(event: MachineEvent): void {
  logger.info("Machine event", {
    type: event.type,
    state: event.state,
    agent: event.context?.currentMode,
    iteration: event.context?.iterationCount,
  });
}
```

#### Metrics

```typescript
// src/observability/metrics.ts
interface Metrics {
  /** Track task duration */
  taskDuration: Histogram;

  /** Track agent iterations */
  agentIterations: Counter;

  /** Track token usage */
  tokenUsage: Counter;

  /** Track errors by category */
  errors: Counter;

  /** Track tool invocations */
  toolCalls: Counter;
}
```

#### Tracing

```typescript
// src/observability/tracing.ts
interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  children: Span[];
}

function traceAgentExecution(agent: string): Span {
  return {
    name: `agent.${agent}`,
    startTime: Date.now(),
    attributes: { agent },
    children: [],
  };
}
```

### Extension Points

#### Custom Providers

```typescript
// Implement Provider interface
class CustomProvider implements Provider {
  readonly name = "custom";
  // ...
}

// Register with factory
ProviderFactory.register(new CustomProvider());
```

#### Custom Tools

```typescript
// Define custom tool
const customTool: ToolDefinition = {
  name: "DatabaseQuery",
  description: "Execute read-only database queries",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "SQL query" },
    },
    required: ["query"],
  },
  handler: async (input) => {
    // Implementation
  },
};

// Register with registry
toolRegistry.register(customTool);
```

#### Custom Agents

Create `.rawko/agents/custom.yaml`:

```yaml
name: custom
displayName: Custom Agent
systemPrompt: |
  You are a specialized agent...
tools:
  allowed: [Read, DatabaseQuery]
transitions:
  onSuccess: developer
```

## Examples

### Minimal Integration

```typescript
import { Rawko } from "@rawkode/rawko-sdk";

const rawko = new Rawko({
  configPath: ".rawko/config.yaml",
});

await rawko.run("Implement user authentication");
```

### Programmatic Control

```typescript
import { createActor } from "xstate";
import { rawkoMachine } from "@rawkode/rawko-sdk";

const actor = createActor(rawkoMachine, {
  input: { /* custom context */ },
});

actor.subscribe((snapshot) => {
  console.log("State:", snapshot.value);
});

actor.start();
actor.send({ type: "START_TASK", task: "..." });

// Cancel if needed
actor.send({ type: "CANCEL" });
```

## Drawbacks

1. **Complexity** - Multiple interacting components increase cognitive load
2. **Debugging** - Async flows across components are hard to trace
3. **Testing** - Integration tests require mocking many components
4. **Performance** - Multiple LLM calls add latency

## Unresolved Questions

1. **Plugin system** - Should we support loading external providers/tools?
2. **Remote execution** - Support for running agents on remote machines?
3. **Multi-project** - Working across multiple repositories?
4. **Collaboration** - Multiple users on same task?
