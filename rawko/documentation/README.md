# rawko Documentation

Technical documentation for `rawko` - an agentic coding robot implemented as a Rust binary that uses FSMs to orchestrate ACP-based agents.

## Overview

rawko is an intelligent coding assistant that coordinates multiple specialized agents through a finite state machine architecture. Each agent has specific capabilities and tools, and an LLM-based arbiter determines how tasks flow between agents based on context and outcomes.

## Documentation Index

### RFCs (Request for Comments)

Detailed technical specifications for major system components:

| RFC | Title | Description |
|-----|-------|-------------|
| [RFC-0001](./rfcs/0001-core-architecture.md) | Core Architecture | System architecture and component design |
| [RFC-0002](./rfcs/0002-agent-definition-format.md) | Agent Definition Format | YAML+markdown specification for defining agents |
| [RFC-0003](./rfcs/0003-state-persistence.md) | State Persistence | Local state storage specification |
| [RFC-0004](./rfcs/0004-observability.md) | Observability | OpenTelemetry and logging specification |

### ADRs (Architecture Decision Records)

Records of significant architectural decisions:

| ADR | Title | Summary |
|-----|-------|---------|
| [ADR-0001](./adrs/0001-rust-language.md) | Rust Language | Performance, safety, and ecosystem |
| [ADR-0002](./adrs/0002-acp-protocol.md) | ACP Protocol | Model-agnostic standard protocol |
| [ADR-0003](./adrs/0003-statig-fsm.md) | statig FSM | Superstate support, future hierarchy |
| [ADR-0004](./adrs/0004-tokio-runtime.md) | Tokio Runtime | Battle-tested async runtime |
| [ADR-0005](./adrs/0005-capability-based-security.md) | Capability-based Security | Agents only get declared tools |
| [ADR-0006](./adrs/0006-llm-arbiter.md) | LLM Arbiter | Flexible routing, handles ambiguity |
| [ADR-0007](./adrs/0007-stdio-transport.md) | stdio Transport | Simple subprocess model for ACP |
| [ADR-0008](./adrs/0008-cue-configuration.md) | CUE Configuration | Typed config via cuengine crate |
| [ADR-0009](./adrs/0009-otel-observability.md) | OTEL Observability | Future-proof tracing infrastructure |
| [ADR-0010](./adrs/0010-cli-interface.md) | CLI Interface | Streaming terminal output |

## Key Concepts

### Agents

Agents are specialized workers with defined capabilities. Each agent has:
- A system prompt defining its behavior
- A set of allowed tools
- Model preferences
- Valid transitions to other agents

### Arbiter

The arbiter is an LLM-based orchestrator that:
- Receives tasks from users
- Selects appropriate agents to handle work
- Evaluates agent outputs
- Determines next steps or completion

### Tools

Tools are capabilities exposed to agents:
- **Filesystem**: Read/write files
- **Shell**: Execute commands
- **Git**: Version control operations
- **MCP**: Model Context Protocol servers

### State Machine

The FSM architecture:
- States represent agent roles (not workflow phases)
- Transitions are arbiter decisions
- Events are agent completions or failures

## Getting Started

See the individual RFCs for detailed technical specifications and the ADRs for context on why specific technologies were chosen.
