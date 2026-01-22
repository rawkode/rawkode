# RFC-0001: Core Architecture

## Abstract

This RFC describes the core architecture of rawko, an agentic coding robot that orchestrates multiple specialized agents through a finite state machine (FSM) design. The system uses an LLM-based arbiter to route tasks between peer agents, each with specific capabilities and tool access. Communication with agents follows the Agent Communication Protocol (ACP), enabling model-agnostic agent implementations.

rawko is designed as a flat peer model where agents are specialized workers rather than hierarchical managers. The arbiter serves as the intelligent router, evaluating context and outcomes to determine optimal task flow.

## Motivation

Traditional coding assistants operate as monolithic systems where a single LLM handles all tasks. This approach has limitations:

1. **Capability sprawl**: A single agent must be given all tools, increasing security surface
2. **Context pollution**: Different tasks (planning vs. coding vs. review) benefit from different prompts and context
3. **Inflexibility**: Changing behavior requires modifying the core system
4. **Lack of specialization**: Different tasks may benefit from different models or configurations

rawko addresses these by separating concerns into specialized agents coordinated by an intelligent arbiter.

## Detailed Design

### Components

#### 1. Core Arbiter

The arbiter is an LLM-based orchestrator responsible for:

- Receiving user tasks via CLI
- Analyzing task requirements and context
- Selecting appropriate agents to handle work
- Evaluating agent outputs and determining success
- Deciding next steps: retry, transition to another agent, or complete

The arbiter maintains awareness of:
- Available agents and their capabilities
- Current task state and history
- Previous agent outputs and their success/failure status

#### 2. Agent Pool

Agents are flat peers with specialized roles:

| Agent | Purpose | Primary Tools |
|-------|---------|---------------|
| Planner | Breaks down tasks into steps | filesystem (read) |
| PM | Manages requirements, priorities | filesystem |
| Developer | Writes and modifies code | filesystem, shell, git |
| Reviewer | Reviews code changes | filesystem, git |
| Debugger | Investigates and fixes issues | filesystem, shell |
| Researcher | Gathers information | filesystem, shell, MCP |

Each agent has:
- A system prompt defining behavior
- Declared tool access (capability-based security)
- Model preferences/hints
- Valid transition targets

#### 3. Tool Registry

Tools are capabilities exposed to agents through ACP:

- **Filesystem**: Read, write, list, search files
- **Shell**: Execute commands with configurable restrictions
- **Git**: Repository operations (status, diff, commit, etc.)
- **MCP Servers**: External tool integrations via Model Context Protocol

Tool access is granted per-agent based on declarations. Agents cannot access undeclared tools.

#### 4. State Manager

Persists task and conversation state locally:

- Task history and outcomes
- Agent conversation context
- Intermediate results
- Retry/failure tracking

See [RFC-0003: State Persistence](./0003-state-persistence.md) for details.

#### 5. ACP Client

Manages communication with agents via ACP over stdio:

- Spawns agent subprocesses
- Handles request/response messaging
- Manages tool call execution
- Streams output for terminal display

### Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User CLI                                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ Task
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Arbiter                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Analyze task                                          │   │
│  │ 2. Select agent based on requirements                    │   │
│  │ 3. Invoke agent with context                             │   │
│  │ 4. Evaluate result                                       │   │
│  │ 5. Decide: complete | retry | transition                 │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│   Planner     │       │   Developer   │       │   Reviewer    │
│   Agent       │       │   Agent       │       │   Agent       │
└───────┬───────┘       └───────┬───────┘       └───────┬───────┘
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                │
                                ▼
                    ┌───────────────────┐
                    │   Tool Registry   │
                    │  ┌─────────────┐  │
                    │  │ Filesystem  │  │
                    │  │ Shell       │  │
                    │  │ Git         │  │
                    │  │ MCP         │  │
                    │  └─────────────┘  │
                    └───────────────────┘
```

#### Step-by-step Flow

1. **Task Receipt**: User invokes CLI with a task description
2. **Arbiter Analysis**: Arbiter analyzes task, selects initial agent
3. **Agent Invocation**: Selected agent receives task via ACP
4. **Tool Execution**: Agent requests tools, rawko executes and returns results
5. **Agent Response**: Agent completes and returns result to arbiter
6. **Evaluation**: Arbiter evaluates success/failure
7. **Routing Decision**:
   - **Success + Complete**: Return result to user
   - **Success + Continue**: Transition to next agent
   - **Failure**: Retry with same or alternative agent
8. **Loop**: Repeat from step 3 until completion or failure limit

### FSM Design

The finite state machine represents agent orchestration:

```
States = { Idle, Planner, Developer, Reviewer, Debugger, ... }
Events = { TaskReceived, AgentComplete, AgentFailed, UserCancel }
```

Key design decisions:

- **States are agent roles**, not workflow phases
- **Transitions are arbiter decisions**, not hardcoded paths
- **The arbiter is the transition function**, using LLM reasoning to select next state
- **Superstates** (via statig) enable future hierarchical patterns if needed

Example transitions:
```
Idle --[TaskReceived]--> Planner
Planner --[AgentComplete]--> Developer
Developer --[AgentComplete]--> Reviewer
Developer --[AgentFailed]--> Debugger
Reviewer --[AgentComplete]--> Idle (task done)
Reviewer --[AgentFailed]--> Developer (needs fixes)
```

### Error Handling

**Agent Failures**:
- Arbiter tracks failure count per agent per task
- On failure, may retry same agent with additional context
- May route to alternative agent (e.g., Debugger)
- After max retries, escalates to user

**Tool Failures**:
- Tool errors returned to agent for handling
- Agent decides whether to retry, work around, or fail

**Arbiter Failures**:
- LLM errors trigger retry with backoff
- Persistent failures halt task with error report

## Drawbacks

1. **Latency**: Multiple LLM calls (arbiter + agents) increase response time
2. **Complexity**: More moving parts than monolithic design
3. **Cost**: More LLM invocations means higher API costs
4. **Debugging**: Distributed logic harder to trace

## Alternatives

### Single Agent with Mode Switching

One agent that changes behavior based on explicit modes. Rejected because:
- Still has capability sprawl
- Mode switching logic becomes complex
- Harder to customize individual behaviors

### Hardcoded Workflow Pipeline

Fixed sequence of agents (Plan → Code → Review). Rejected because:
- Inflexible for varied task types
- Doesn't handle failures gracefully
- Can't adapt to context

### Hierarchical Agent Trees

Manager agents that delegate to worker agents. Deferred (not rejected):
- Current flat model is simpler to implement
- statig superstates enable future hierarchy
- Can evolve if needed

## Unresolved Questions

1. **Arbiter prompt design**: Optimal prompt structure for routing decisions
2. **Context window management**: How to handle long conversations
3. **Parallel agent execution**: Whether/when agents can run concurrently
4. **Human-in-the-loop**: Integration points for user confirmation
