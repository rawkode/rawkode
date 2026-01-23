# Documentation Review: State and Memory Management

**Date**: 2026-01-23
**Scope**: Arbiter responsibilities, agent context, long-term memory
**Status**: COMPLETE

## Executive Summary

The rawko-sdk uses a **stateless execution model** with **long-term memory** for cross-task learning:

- **No session persistence** - Each task run is independent (prevents context rot)
- **Long-term memories** - Stored in `.rawko/memories/` as Markdown with YAML frontmatter
- **Memory extraction** - Valuable learnings extracted after agent execution
- **Memory injection** - Relevant memories injected into agent prompts

## Architecture Overview

```
Task Start (independent)
       |
       v
+----------------+     +-------------------+
|    Arbiter     |---->|  Select Agent     |
+----------------+     +-------------------+
       |                       |
       v                       v
+----------------+     +-------------------+
| Load Memories  |---->|   Inject into     |
| (.rawko/       |     |   Agent Prompt    |
|  memories/)    |     +-------------------+
+----------------+             |
                               v
                      +-------------------+
                      |  Agent Executes   |
                      +-------------------+
                               |
                               v
                      +-------------------+
                      | Extract Memories  |
                      | (if valuable)     |
                      +-------------------+
                               |
                               v
                      +-------------------+
                      | Evaluate Progress |
                      +-------------------+
```

## Key Specifications

| Spec | Description |
|------|-------------|
| SPEC-0005 | Long-term memory extraction and storage |
| SPEC-0006 | Arbiter context construction |
| SPEC-0007 | Memory injection into agent prompts |
| SPEC-0009 | Unified memory architecture (consolidates 0005, 0007) |
| SPEC-0010 | Plan schema for task coordination |

## Core Principles

1. **Stateless Execution** - Every task run starts fresh with no inherited state
2. **Append-Only Memories** - Memories are never deleted, only added
3. **Selective Injection** - Only relevant memories are included in prompts
4. **Background Knowledge** - Memories provide context, not state restoration

## Memory File Format

Location: `.rawko/memories/*.md`

```markdown
---
title: "Authentication Module Structure"
whenToUse:
  - "auth|authentication|login"
tags: [auth, codebase-structure]
importance: high
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
---

# Authentication Module Structure

Content describing what was learned...
```

## What Gets Remembered

**YES - Extract**:
- Codebase structure discoveries
- Code patterns and conventions
- Errors and their root causes
- Architectural decisions
- Key constraints or limitations

**NO - Skip**:
- Temporary debugging steps
- Verbose command output
- Trivial findings
- Duplicates of existing memories

## Related Documentation

- ADR-0005: LLM Arbiter
- ADR-0006: Tool Filtering
- SPEC-0003: XState Machine
- SPEC-0004: Agent Config Schema

---

**Status**: This review is complete. All gaps have been addressed in the relevant specifications.
