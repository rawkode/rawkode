# ADR 0001: Build `rawko` as a Deno CLI with multi-SDK provider adapters

- Status: Accepted
- Date: 2026-02-11

## Context

The current `ralph.nu` script is a useful prototype, but it is tightly coupled to local CLI binaries
and hardcoded model/provider flags. The target system must:

- Run in any project directory.
- Load agent definitions from local files.
- Support OpenAI, Anthropic, and GitHub providers.
- Use configurable agents and failover models.
- Operate as a long-running orchestration loop.

## Decision

Build `rawko` as a Deno CLI with an internal provider abstraction and SDK adapters for:

- OpenAI Agents SDK
- Claude Agent SDK
- GitHub Copilot SDK

Provider/model selection comes from agent frontmatter. The CLI orchestrates agents through internal
actors and message queues rather than shelling out to provider CLIs.

## Consequences

### Positive

- Stronger portability and packaging than shell-only orchestration.
- Clear separation of orchestration logic from provider-specific implementation.
- Easier to add provider/model failover across SDK boundaries.

### Negative

- Higher implementation complexity than a shell script.
- Requires adapter maintenance as SDKs evolve.

### Neutral

- Runtime behavior is determined primarily by agent prompts and manager delegation policy, not
  hardcoded task logic.
