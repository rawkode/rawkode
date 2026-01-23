# rawko-sdk Documentation

This directory contains Architecture Decision Records (ADRs) and specifications for rawko-sdk, a TypeScript/Deno rewrite of rawko that uses Claude Agent SDK and GitHub Copilot SDK with explicit FSM mode states.

## Overview

rawko-sdk is a complete TypeScript rewrite that:
- Uses **Deno** as the runtime (not Node.js)
- Uses **XState v5** for finite state machine implementation
- Supports **Claude Agent SDK** and **GitHub Copilot SDK** as providers
- Loads FSM states/agents from `.rawko/agents/*.yaml` configuration files

## Architecture Decision Records (ADRs)

ADRs document significant architectural decisions with their context, consequences, and alternatives considered.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](adrs/0001-deno-typescript.md) | Deno + TypeScript | Proposed |
| [0002](adrs/0002-provider-abstraction.md) | Provider Abstraction Layer | Proposed |
| [0003](adrs/0003-xstate-fsm.md) | XState for FSM | Proposed |
| [0004](adrs/0004-agent-config-format.md) | Agent Config Format | Proposed |
| [0005](adrs/0005-llm-arbiter.md) | LLM-Based Arbiter | Proposed |
| [0006](adrs/0006-tool-filtering.md) | Mode-Based Tool Filtering | Proposed |
| [0007](adrs/0007-session-management.md) | Session Management | Proposed |

## Specifications

Specifications provide detailed technical designs for implementing rawko-sdk components.

| Spec | Title |
|------|-------|
| [0001](specs/0001-core-architecture.md) | Core Architecture |
| [0002](specs/0002-provider-interface.md) | Provider Interface |
| [0003](specs/0003-xstate-machine.md) | XState Machine Definition |
| [0004](specs/0004-agent-config-schema.md) | Agent Config Schema (YAML Format) |
| [0005](specs/0005-long-term-memory.md) | Long-Term Memory and Extraction |
| [0006](specs/0006-agent-configuration.md) | Agent Configuration (Markdown Format) |
| [0007](specs/0007-arbiter-memory-injection.md) | Arbiter Memory Injection |

## Conventions and Guidelines

Conventions document design patterns, best practices, and implementation guidelines.

| Document | Purpose |
|----------|---------|
| [Agent Files (Markdown)](conventions/AGENT-FILES-MARKDOWN.md) | Agent definition format with YAML frontmatter |
| [Memory Files (Markdown)](conventions/MEMORY-FILES-MARKDOWN.md) | Long-term memory storage with YAML frontmatter |

## Configuration

Default configuration and agent definitions are stored in the `.rawko/` directory:

```
.rawko/
├── config.yaml          # Global configuration
└── agents/
    ├── planner.yaml     # Planning mode agent
    ├── developer.yaml   # Development mode agent
    ├── tester.yaml      # Testing mode agent
    └── reviewer.yaml    # Review mode agent
```

## Key Design Decisions

| Aspect | Original rawko | rawko-sdk |
|--------|----------------|-----------|
| Language | Rust | TypeScript |
| Runtime | Tokio | Deno |
| Protocol | ACP | Claude SDK + Copilot SDK |
| FSM States | idle/selecting/executing/evaluating | Loaded from .rawko/agents/*.yaml |
| FSM Library | statig | XState v5 |
| Config | CUE (.rawko/config.cue) | YAML (.rawko/config.yaml) |
| Agent Definitions | Rust code + CUE | YAML (.rawko/agents/) |
| Arbiter | LLM-based | LLM-based (retained) |

## Document Templates

### ADR Template

ADRs follow a standard format documenting:
- **Status**: Proposed, Accepted, Deprecated, or Superseded
- **Context**: Problem statement and background
- **Decision**: The architectural choice made
- **Consequences**: Positive and negative impacts
- **Alternatives Considered**: Other options evaluated
- **Implementation Notes**: Technical details for implementers

### Specification Template

Specifications include:
- **Abstract**: Brief summary
- **Motivation**: Why this specification exists
- **Detailed Design**: Component designs with TypeScript interfaces
- **Examples**: Usage examples
- **Drawbacks**: Known limitations
- **Unresolved Questions**: Open issues
