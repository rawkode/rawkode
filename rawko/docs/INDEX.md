# Documentation Index

Complete index of all rawko-sdk documentation with reading order and relationships.

## Getting Started

**New to rawko-sdk?** Start here:
1. [README.md](README.md) - Overview and structure
2. [SPEC-0001](specs/0001-core-architecture.md) - Core architecture

**Implementing memory system?** Read:
1. **[SPEC-0009: Memory Architecture](specs/0009-memory-architecture.md)** - Unified reference

## Architecture Decision Records (ADRs)

Decisions about the overall approach and design.

| ADR | Title | Status | Read When |
|-----|-------|--------|-----------|
| [0001](adrs/0001-deno-typescript.md) | Deno + TypeScript | Accepted | Understanding tech stack |
| [0002](adrs/0002-provider-abstraction.md) | Provider Abstraction Layer | Accepted | Implementing LLM providers |
| [0003](adrs/0003-xstate-fsm.md) | XState for FSM | Accepted | Implementing state machine |
| [0004](adrs/0004-agent-config-format.md) | Agent Config Format | Accepted | Defining custom agents |
| [0005](adrs/0005-llm-arbiter.md) | LLM-Based Arbiter | Accepted | Understanding agent selection |
| [0006](adrs/0006-tool-filtering.md) | Mode-Based Tool Filtering | Accepted | Implementing tool access control |

## Specifications (SPECs)

Detailed technical designs ready for implementation.

| Spec | Title | Dependencies |
|------|-------|--------------|
| [0001](specs/0001-core-architecture.md) | Core Architecture | None |
| [0002](specs/0002-provider-interface.md) | Provider Interface | ADR-0002 |
| [0003](specs/0003-xstate-machine.md) | XState Machine | ADR-0003 |
| [0004](specs/0004-agent-config-schema.md) | Agent Config Schema | ADR-0004 |
| [0005](specs/0005-long-term-memory.md) | Long-Term Memory | SPEC-0001 |
| [0006](specs/0006-arbiter-context-construction.md) | Arbiter Context | ADR-0005, SPEC-0005 |
| [0007](specs/0007-arbiter-memory-injection.md) | Arbiter Memory Injection | SPEC-0005, SPEC-0006 |
| [0008](specs/0008-agent-configuration.md) | Agent Configuration | ADR-0004 |
| [0009](specs/0009-memory-architecture.md) | Memory Architecture (Unified) | SPEC-0005, SPEC-0006, SPEC-0007 |
| [0010](specs/0010-plan-schema.md) | Plan Schema | SPEC-0003 |

## Conventions and Guidelines

Best practices and design patterns.

| Document | Purpose |
|----------|---------|
| [MEMORY-FILES.md](conventions/MEMORY-FILES.md) | Session-scoped memory specification |
| [MEMORY-FILES-MARKDOWN.md](conventions/MEMORY-FILES-MARKDOWN.md) | Long-term memory Markdown format |
| [AGENT-FILES-MARKDOWN.md](conventions/AGENT-FILES-MARKDOWN.md) | Agent configuration Markdown format |

## Reading Paths by Role

### For Architects
1. [ADR-0001](adrs/0001-deno-typescript.md) - Tech stack
2. [ADR-0003](adrs/0003-xstate-fsm.md) - FSM approach
3. [SPEC-0001](specs/0001-core-architecture.md) - System design
4. [SPEC-0003](specs/0003-xstate-machine.md) - Machine definition

### For Memory Implementers
1. **[SPEC-0009](specs/0009-memory-architecture.md) - Unified Memory Architecture (start here)**
2. [conventions/MEMORY-FILES.md](conventions/MEMORY-FILES.md) - Session memory quick reference
3. [conventions/MEMORY-FILES-MARKDOWN.md](conventions/MEMORY-FILES-MARKDOWN.md) - Long-term memory quick reference

### For Arbiter Implementers
1. [ADR-0005](adrs/0005-llm-arbiter.md) - Decision rationale
2. [SPEC-0006](specs/0006-arbiter-context-construction.md) - Context construction
3. [SPEC-0007](specs/0007-arbiter-memory-injection.md) - Memory injection
4. [conventions/MEMORY-FILES.md](conventions/MEMORY-FILES.md) - Memory usage

### For Agent Developers
1. [ADR-0004](adrs/0004-agent-config-format.md) - Config format rationale
2. [SPEC-0004](specs/0004-agent-config-schema.md) - Config schema (YAML)
3. [SPEC-0008](specs/0008-agent-configuration.md) - Config format (Markdown)
4. [conventions/AGENT-FILES-MARKDOWN.md](conventions/AGENT-FILES-MARKDOWN.md) - Agent file conventions

### For Tool/Provider Implementers
1. [SPEC-0002](specs/0002-provider-interface.md) - Provider contract
2. [SPEC-0001](specs/0001-core-architecture.md) - Integration points
3. [ADR-0006](adrs/0006-tool-filtering.md) - Tool filtering rules

## Document Relationships

```
ADR-0001 (Deno+TS)
  └─→ SPEC-0002 (Provider Interface)
  └─→ SPEC-0003 (XState Machine)

ADR-0002 (Provider Abstraction)
  └─→ SPEC-0002 (Provider Interface)

ADR-0003 (XState FSM)
  └─→ SPEC-0001 (Core Architecture)
  └─→ SPEC-0003 (XState Machine)

ADR-0004 (Agent Config)
  └─→ SPEC-0004 (Agent Config Schema)
  └─→ SPEC-0008 (Agent Configuration)

ADR-0005 (LLM Arbiter)
  └─→ SPEC-0006 (Context Construction)
  └─→ SPEC-0007 (Memory Injection)

SPEC-0001 (Core Architecture)
  ├─→ SPEC-0002 (Provider details)
  ├─→ SPEC-0003 (Machine details)
  └─→ SPEC-0005 (Memory integration)

SPEC-0005 (Long-Term Memory)
  └─→ SPEC-0006 (Arbiter uses memory)
  └─→ SPEC-0007 (Memory injection)
  └─→ conventions/MEMORY-FILES.md

SPEC-0006 (Arbiter Context)
  └─→ SPEC-0007 (Memory injection step)
  └─→ conventions/MEMORY-FILES.md
```

## Documentation by Topic

### Memory and Learning
- **[SPEC-0009](specs/0009-memory-architecture.md) - Unified Memory Architecture (start here)**
- [SPEC-0005](specs/0005-long-term-memory.md) - Memory extraction details
- [SPEC-0007](specs/0007-arbiter-memory-injection.md) - Memory injection details
- [conventions/MEMORY-FILES.md](conventions/MEMORY-FILES.md) - Session memory quick reference
- [conventions/MEMORY-FILES-MARKDOWN.md](conventions/MEMORY-FILES-MARKDOWN.md) - Long-term memory quick reference

### Arbiter and Decision Making
- [ADR-0005](adrs/0005-llm-arbiter.md) - Arbiter design rationale
- [SPEC-0006](specs/0006-arbiter-context-construction.md) - How arbiter receives context
- [SPEC-0007](specs/0007-arbiter-memory-injection.md) - How arbiter injects memory

### Agent Configuration and Execution
- [ADR-0004](adrs/0004-agent-config-format.md) - Config approach
- [SPEC-0004](specs/0004-agent-config-schema.md) - YAML config schema
- [SPEC-0008](specs/0008-agent-configuration.md) - Markdown config format
- [SPEC-0001](specs/0001-core-architecture.md) - Agent executor component

### Provider Integration
- [SPEC-0002](specs/0002-provider-interface.md) - Provider abstraction
- [SPEC-0001](specs/0001-core-architecture.md) - Provider in architecture

### Tool Management
- [ADR-0006](adrs/0006-tool-filtering.md) - Tool filtering design
- [SPEC-0001](specs/0001-core-architecture.md) - Tool registry in architecture

## Quick Reference

### How do I...?

**...understand the system architecture?**
→ [SPEC-0001](specs/0001-core-architecture.md)

**...create a custom agent?**
→ [SPEC-0008](specs/0008-agent-configuration.md) + [conventions/AGENT-FILES-MARKDOWN.md](conventions/AGENT-FILES-MARKDOWN.md)

**...implement the state machine?**
→ [ADR-0003](adrs/0003-xstate-fsm.md) + [SPEC-0003](specs/0003-xstate-machine.md)

**...implement memory persistence?**
→ [SPEC-0005](specs/0005-long-term-memory.md)

**...implement the arbiter?**
→ [ADR-0005](adrs/0005-llm-arbiter.md) + [SPEC-0006](specs/0006-arbiter-context-construction.md)

**...add a new provider?**
→ [SPEC-0002](specs/0002-provider-interface.md)

**...understand tool filtering?**
→ [ADR-0006](adrs/0006-tool-filtering.md)

**...implement agent memory?**
→ [SPEC-0009](specs/0009-memory-architecture.md)

**...understand error handling?**
→ [SPEC-0001](specs/0001-core-architecture.md) (Error Handling section)

## Document Statistics

- **ADRs**: 6 documents
- **SPECs**: 10 documents
- **Conventions**: 3 documents
- **Total**: 19 documents

---

**Last updated**: January 23, 2026
