# Rawko CLI Specification

- Status: Draft for implementation
- Date: 2026-02-11

## 1. Scope

`rawko` is a Deno CLI that orchestrates configurable agents in an actor-style infinite loop. The
manager delegates work until a council of agents unanimously agrees the user objective is complete.

## 2. Goals

- Run from any project directory.
- Load agent prompts/config from `.rawko/agents/*.mdx`.
- Support OpenAI, Anthropic, and GitHub providers through SDK adapters.
- Allow parallel delegation by a manager agent.
- Keep interactive user communication available throughout runtime.
- Continue running after completion for interactive manager chat.

## 3. Non-Goals

- No built-in TODO/task-list feature.
- No persistent state required between runs.
- No built-in CLI safety/tool restriction policy in v1.

## 4. CLI Interface

## 4.1 Command name

- Binary name: `rawko`

## 4.2 Invocation modes

- `rawko "Build X"`: starts run with initial objective.
- `rawko`: starts manager with no initial objective; waits for user message.

## 4.3 Runtime behavior

- Unbounded runtime by default.
- User can stop with `Ctrl+C`.
- User input is delivered to manager via `UserActor` message queue.
- Manager responds only on user request (no proactive status spam).

## 5. Project and Agent Discovery

## 5.1 Search roots

Agents are loaded from:

1. Current working directory: `./.rawko/agents/*.mdx`
2. Git repository root: `<git_root>/.rawko/agents/*.mdx` (if different from CWD)

If both roots exist, merge by filename with CWD taking precedence.

## 5.2 Validation policy

Hard-fail startup if config is invalid:

- No manager agent found.
- Multiple manager agents found.
- No council agents found.
- Missing required frontmatter or invalid model route entries.

No additional provider credential preflight is required in v1.

## 6. Agent File Format (`.mdx`)

## 6.1 Frontmatter

Required keys:

- `name: string`
- `useMe: string` (delegation guidance)
- `manager: boolean`
- `council: boolean`
- One model route source:
  - Preferred: `models: [{ provider, model, thinking? }, ...]`
  - Compatibility: `provider + model (+ thinking)` converted to one route

Allowed provider values:

- `openai`
- `anthropic`
- `github`

Manager restriction:

- Manager model routes must use only `openai` or `anthropic`.

## 6.2 Body

- MDX body is the full system prompt for that agent.
- CLI must not append hidden global system prompts in v1.
- Agent prompts should not require rigid output syntax (JSON-only, keyword-only verdicts, etc.).

## 6.3 Example

```mdx
---
name: "Lead Manager"
manager: true
council: false
useMe: "Coordinate workers, break down objectives, request council vote only when ready."
models:
  - provider: openai
    model: gpt-5
    thinking: high
  - provider: anthropic
    model: opus
    thinking: high
---
You are the manager. Delegate implementation. Do not do direct implementation work.
```

## 7. Runtime Architecture

## 7.1 Actors

- `ManagerActor` (single): orchestration brain, no direct implementation work.
- `WorkerActor` (many): delegated implementation/research agents.
- `CouncilActor` (many): completion voting agents.
- `UserActor` (single): interactive input source.
- `HealthMonitorActor` (single): probes off-sick agents every 5 minutes.

## 7.2 Message envelope

Internal actor messages should carry:

- `id`
- `from`
- `to`
- `type`
- `content` (free-form text)
- `createdAt`
- optional `correlationId`

Agent-generated content remains free-form text.

## 8. Manager State Machine

Manager is an infinite loop with event-driven transitions.

Core states:

1. `BOOTSTRAP`
2. `WAIT_FOR_OBJECTIVE`
3. `PLAN_DELEGATION`
4. `DISPATCH_WORKERS`
5. `COLLECT_WORKER_RESPONSES`
6. `INTEGRATE_FEEDBACK`
7. `REQUEST_COUNCIL_VOTE` (only when manager decides)
8. `HANDLE_COUNCIL_RESULT`
9. `INTERACTIVE_COMPLETE` (objective complete, still chat-enabled)
10. `SHUTDOWN` (Ctrl+C)

Transition rules:

- `WAIT_FOR_OBJECTIVE` -> `PLAN_DELEGATION` on first objective message.
- `PLAN_DELEGATION` selects agents via LLM judgment over `useMe`.
- `DISPATCH_WORKERS` launches up to concurrency limit (default 4).
- `REQUEST_COUNCIL_VOTE` only when manager declares readiness.
- Unanimous completion from all council members -> `INTERACTIVE_COMPLETE`.
- Any council dissent -> pass only dissenting feedback to manager and return to `PLAN_DELEGATION`.

## 9. Delegation and Parallelism

- Manager can dispatch multiple workers in parallel.
- Default max parallel workers: `4`.
- Workers share the same working directory.
- Manager is responsible for assigning concurrently safe scopes.
- Council members may also be used as workers when manager chooses.

## 10. Completion Protocol

- Completion criterion: unanimous council agreement that original objective is complete.
- Council prompt bodies remain free-form, but runtime requests structured verdict output from providers.
- Manager next-action selection is also requested as structured output.
- If not unanimous, manager receives only incomplete/dissenting feedback.

## 11. Failure Handling and Recovery

Applies to all agents (manager, workers, council):

1. For each invocation, attempt configured model routes in priority order.
2. On failure, retry immediate attempts up to 4 times.
3. If still failing, mark agent `off_sick`.
4. `HealthMonitorActor` sends liveness ping every 5 minutes: `"Are you alive?"`
5. Any valid response marks agent alive and re-adds to active pool immediately.

## 12. Provider Adapter Contract

Each adapter must implement:

- `invoke(systemPrompt, conversation, modelRoute, toolsContext) -> text`
- `invokeStructured(systemPrompt, conversation, modelRoute, outputSchema) -> object`
- Error normalization to common runtime error types.
- Timeout and cancellation support.

Adapters:

- `OpenAIAdapter` for `provider=openai`
- `ClaudeAdapter` for `provider=anthropic`
- `GitHubAdapter` for `provider=github`

For `provider=github`, models must be available via GitHub provider routing.

## 13. Data and Persistence

- In-memory runtime state only.
- No required persisted transcripts or checkpoints.
- Files written by agents are project outputs, not runtime artifacts.

## 14. User Interaction Model

- User input is free-form text to manager.
- No mandatory slash commands in v1.
- Manager can answer status/progress when user asks.

## 15. Security and Permissions

- No CLI-level tool restriction policy in v1.
- Agents may perform required project operations.
- Future policy controls can be introduced per adapter and manager prompt policy.

## 16. Implementation Plan

1. Scaffold Deno CLI (`rawko`) and config loader.
2. Build agent discovery and frontmatter validation.
3. Implement actor runtime primitives (mailboxes, scheduler, cancellation).
4. Implement provider adapter interface and three adapters.
5. Implement manager loop states and delegation logic.
6. Add council vote flow and dissent-only feedback handling.
7. Add off-sick queue and 5-minute health monitor.
8. Add interactive terminal input actor and graceful Ctrl+C shutdown.
9. Add integration tests with mocked adapters for state transitions and failover.
