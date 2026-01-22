# rawko Implementation TODO

Sequential implementation tasks for building rawko. Each task should be completable in a focused session.

## Architecture Overview

rawko is an **ACP Client** that **orchestrates** multiple **ACP Agents**:

- **Agents**: External ACP-compliant agents (Claude Code, Gemini CLI, Aider, custom) that handle their own tools and LLM calls
- **Client (rawko)**: Spawns agents, manages sessions, sends prompts, receives responses
- **Arbiter**: Decides which agent to invoke based on task context
- **FSM**: Manages state transitions between agents

rawko does NOT:
- Implement filesystem/terminal capabilities (agents handle their own execution)
- Talk to LLMs directly (agents do that)
- Provide tools to agents (agents bring their own)

---

## Phase 1: Project Foundation

### 1.1 Project Scaffolding
- [x] Initialize Cargo workspace with `rawko` binary crate
- [x] Add initial dependencies to Cargo.toml (tokio, serde, clap, tracing)
- [x] Create basic module structure (`src/lib.rs`, `src/main.rs`)
- [ ] Set up `rustfmt.toml` and `clippy.toml` for code style
- [ ] Add `.gitignore` entries for target/, .rawko/state/

### 1.2 Error Handling Foundation
- [x] Create `src/error.rs` with custom error types using `thiserror`
- [x] Define `Result<T>` type alias for the crate
- [x] Add error variants for config, agent, and protocol errors

### 1.3 Core Types
- [x] Create `src/types.rs` with foundational types
- [x] Define `TaskId`, `AgentName` newtypes
- [x] Define `TaskStatus` enum (Pending, Running, Completed, Failed)
- [x] Define `AgentResult` struct (status, output)

---

## Phase 2: Configuration System

### 2.1 CUE Schema Definition
- [x] Create `schema/config.cue` with full configuration schema
- [x] Define `#Provider` type for LLM providers (used by arbiter only)
- [x] Define `#ObservabilityConfig` type
- [x] Define `#StateConfig` type
- [x] Define `#Agent` type for agent definitions
- [x] Add `agents: [string]: #Agent` field to `#Config`

### 2.2 Configuration Loading
- [x] Add `cuengine` dependency
- [x] Create `src/config/mod.rs` module
- [x] Implement `Config` struct matching CUE schema
- [x] Implement `load_config()` to find and parse global config
- [x] Implement project config overlay (merge `.rawko/config.cue`)
- [x] Add environment variable substitution (`${VAR}` syntax)
- [x] Add `agents` field to `Config` struct

### 2.3 Configuration Validation
- [x] Add validation for required fields
- [x] Validate provider API key presence (or env var)
- [x] Add helpful error messages for common misconfigurations
- [x] Validate agent transitions reference existing agents

---

## Phase 3: Agent Definitions

### 3.1 Agent Definition Types
- [x] Create `src/agent/mod.rs` module
- [x] Define `AgentDef` struct matching `#Agent` CUE schema
- [x] Define `ModelHints` struct (prefer, avoid lists)
- [x] Add validation for agent name format (`^[a-z][a-z0-9-]*$`)

### 3.2 Agent Registry
- [x] Create `AgentRegistry` to hold loaded agents
- [x] Implement agent lookup by name
- [x] Validate transition targets reference existing agents
- [x] Support agent iteration for arbiter context

### 3.3 Built-in Agent Definitions
- [x] Create `src/agent/builtin.rs` with embedded CUE strings
- [x] Define planner agent
- [x] Define developer agent
- [x] Define reviewer agent
- [x] Define debugger agent
- [x] Load built-in agents before user configs

---

## Phase 4: ACP Client

### 4.1 Add ACP Dependencies
- [x] Add `agent-client-protocol` crate (path to local clone)
- [x] Add `tokio-util` with compat feature
- [x] Add `futures` crate
- [x] Add `async-trait` crate

### 4.2 Agent Connection
- [x] Create `src/acp/mod.rs` module
- [x] Create `src/acp/connection.rs` with `AgentConnection` struct
- [x] Implement `spawn()` to start agent subprocess with ACP
- [x] Implement `initialize()` handshake
- [x] Implement `new_session()` to create ACP session
- [x] Implement `prompt()` to send prompt and receive streaming response
- [x] Implement `cancel()` to cancel running prompt
- [x] Implement `shutdown()` for graceful termination

### 4.3 Minimal Client Implementation
- [x] Create minimal `RawkoClient` implementing ACP `Client` trait
- [x] Implement `session_notification()` to handle agent output
- [x] Return `method_not_found` for fs/terminal methods (agents handle their own)
- [x] Handle streaming output display

### 4.4 Agent Pool
- [x] Create `src/acp/pool.rs` with `AgentPool` struct
- [x] Implement `get_or_spawn()` to lazily spawn agents
- [x] Track active agent connections by name
- [x] Implement `shutdown_all()` for cleanup

### 4.5 Update Agent Config for ACP
- [x] Add `command: string` to `AgentDef` (e.g., "claude", "gemini")
- [x] Add `args: Vec<String>` to `AgentDef` (e.g., ["--acp"])
- [x] Add `env: HashMap<String, String>` for environment variables
- [x] Update CUE schema with ACP launch fields

---

## Phase 5: FSM Orchestration

### 5.1 State Machine Setup
- [x] Add `statig` dependency
- [x] Create `src/fsm/mod.rs` module
- [x] Define `OrchestratorState` enum (Idle, Selecting, Executing, Evaluating)
- [x] Define `OrchestratorEvent` enum (TaskReceived, AgentComplete, AgentFailed)
- [x] Set up basic state machine with statig macros

### 5.2 State Handlers
- [ ] Implement `idle` state handler (wait for task)
- [ ] Implement `selecting` state handler (arbiter decision)
- [ ] Implement `executing` state handler (send prompt to agent via ACP)
- [ ] Implement `evaluating` state handler (check result)
- [ ] Add transition guards and actions

### 5.3 Task Context
- [ ] Define `TaskContext` struct (task_id, request, history)
- [ ] Track agent invocation history
- [ ] Track failure counts for retry logic

---

## Phase 6: Arbiter

### 6.1 Arbiter Core
- [ ] Create `src/arbiter/mod.rs` module
- [ ] Define `ArbiterDecision` enum (SelectAgent, Complete, Retry)
- [ ] Define arbiter system prompt template
- [ ] Implement context formatting for arbiter LLM call

### 6.2 LLM Client for Arbiter
- [ ] Create `src/llm/mod.rs` for arbiter's LLM calls only
- [ ] Implement simple Anthropic API client
- [ ] Implement simple OpenAI API client
- [ ] Use provider from config for arbiter decisions

### 6.3 Agent Selection
- [ ] Implement `select_initial_agent()` for new tasks
- [ ] Implement `select_next_agent()` after agent completion
- [ ] Respect agent transition constraints
- [ ] Include agent descriptions in selection context

### 6.4 Completion Detection
- [ ] Implement `is_task_complete()` evaluation
- [ ] Define completion criteria in arbiter prompt
- [ ] Handle partial success cases

### 6.5 Failure Handling
- [ ] Implement retry logic with backoff
- [ ] Track failure counts per agent
- [ ] Implement alternative agent selection on failure
- [ ] Define max retry limits

---

## Phase 7: State Persistence

### 7.1 State Directory Structure
- [ ] Create `src/state/mod.rs` module
- [ ] Implement `.rawko/state/` directory creation
- [ ] Define task file naming convention
- [ ] Implement task file path generation

### 7.2 Task File Format
- [ ] Define task file header format
- [ ] Define turn record format
- [ ] Define result section format
- [ ] Implement task file writer (append-only)
- [ ] Implement task file parser

### 7.3 SQLite Index
- [ ] Add `rusqlite` dependency
- [ ] Create `src/state/index.rs`
- [ ] Define schema for tasks table
- [ ] Implement index initialization and migration
- [ ] Implement task indexing on completion

### 7.4 Query Operations
- [ ] Implement `list_tasks()` with filters
- [ ] Implement `get_task()` by ID
- [ ] Implement `search_tasks()` by content

### 7.5 Task Resumption
- [ ] Implement `load_task_context()` from file
- [ ] Reconstruct conversation state
- [ ] Resume from last arbiter decision point

---

## Phase 8: Observability

### 8.1 Tracing Setup
- [ ] Add `tracing`, `tracing-subscriber` dependencies
- [ ] Create `src/observability/mod.rs` module
- [ ] Implement `init_tracing()` with layer composition
- [ ] Define standard span attributes

### 8.2 Instrumentation
- [ ] Add `#[instrument]` to task execution
- [ ] Add spans for arbiter decisions
- [ ] Add spans for agent execution (ACP calls)

### 8.3 Terminal Output
- [ ] Create `src/observability/terminal.rs`
- [ ] Stream agent output to terminal
- [ ] Format status updates
- [ ] Implement verbosity filtering

---

## Phase 9: CLI Interface

### 9.1 CLI Structure
- [x] Add `clap` dependency with derive feature
- [ ] Create `src/cli/mod.rs` module
- [ ] Define root `Cli` struct with global options
- [ ] Define `Commands` enum for subcommands
- [ ] Implement argument parsing in main()

### 9.2 Task Command
- [ ] Implement `task` subcommand (also default)
- [ ] Accept task description as positional argument
- [ ] Add `--agent` flag to force initial agent
- [ ] Wire up to orchestrator

### 9.3 History Commands
- [ ] Implement `history` subcommand (list tasks)
- [ ] Implement `history show <id>` for task details

### 9.4 Resume Command
- [ ] Implement `resume <id>` subcommand
- [ ] Load task state from persistence
- [ ] Continue orchestration from last point

### 9.5 Agents Command
- [ ] Implement `agents` subcommand to list agents
- [ ] Show agent name, description, command
- [ ] Add `agents show <name>` for details

---

## Phase 10: Integration & Polish

### 10.1 End-to-End Flow
- [ ] Wire all components together in main()
- [ ] Test complete task execution flow
- [ ] Test agent transitions

### 10.2 Error Messages
- [ ] Review all error paths for user-friendliness
- [ ] Add context to errors
- [ ] Add suggestions for common issues

### 10.3 Testing
- [ ] Add unit tests for config loading
- [ ] Add unit tests for agent parsing
- [ ] Add integration tests for CLI commands

### 10.4 Documentation
- [ ] Write README.md with quick start
- [ ] Document configuration options
- [ ] Add examples for common tasks

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Foundation | Complete | Basic structure in place |
| 2. Configuration | Complete | CUE-based config working |
| 3. Agent Definitions | Complete | Registry and built-ins done |
| 4. ACP Client | Complete | Full client implementation with cancel/shutdown |
| 5. FSM Orchestration | In Progress | 5.1 State Machine Setup complete |
| 6. Arbiter | Not Started | |
| 7. State Persistence | Not Started | |
| 8. Observability | Not Started | |
| 9. CLI Interface | Not Started | |
| 10. Integration | Not Started | |
