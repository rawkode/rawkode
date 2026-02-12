# Workflows Extension

Pure YAML-driven workflow state machine for Pi. Zero prebaked defaults — everything comes from your YAML.

## Commands

- `/workflow [name]` — select active workflow
- `/workflow-status` — show active workflow and run status
- `/workflow-reload` — rediscover workflow YAML files
- `/workflow-run <objective>` — run objective through workflow states
- `/workflow-stop` — stop active workflow run

## Runtime model

1. A workflow defines **states** with instructions, tools, and transitions.
2. Each state can restrict which tools are available.
3. Each state can inject a system prompt for additional LLM context.
4. Transitions happen in two ways:
   - **Auto-advance**: state completes → move to `next` (or next in `stateOrder`).
   - **Verdict-gated**: state defines `verdicts` → LLM must emit `VERDICT: <keyword>` → mapped to next state (or `null` for completion).

## YAML discovery

Loaded in precedence order (later overrides earlier):

1. Global: `~/.pi/agent/workflows.yaml` (or `.yml`)
2. Project chain from git root to cwd: `<dir>/.pi/workflows.yaml` (or `.yml`)

## YAML schema

```yaml
defaultWorkflow: my-workflow

workflows:
  my-workflow:
    description: Example workflow
    initialState: analyze
    stateOrder: [analyze, implement, review]

    states:
      analyze:
        instructions: |
          Analyze the codebase. Produce a clear, actionable plan.
        systemPrompt: |
          You are in analysis mode. Focus on understanding, not implementing.
        tools: [read, bash, grep, find, ls]
        next: implement

      implement:
        instructions: |
          Implement the plan from the analysis phase.
        tools: [read, bash, edit, write, grep, find, ls]
        next: review

      review:
        instructions: |
          Review the implementation for correctness and quality.
        tools: [read, bash, grep, find, ls, subagent]
        systemPrompt: |
          You are reviewing changes. Be thorough and critical.
        verdicts:
          done: null       # workflow complete
          redo: implement  # go back to implement
          rethink: analyze # go back to analyze
```

### State fields

| Field | Description |
|---|---|
| `instructions` | Injected as the user message when entering this state |
| `systemPrompt` | Additional system prompt text for this state |
| `tools` | Allowed tools (omit to allow all) |
| `next` | Default next state (for auto-advance) |
| `verdicts` | Map of verdict keywords → next state (`null` = done) |

## Persistence

Persists selected workflow name and active run state to the session.

## Setup

Dependencies in `.pi/settings.json`:

```json
{
  "packages": ["npm:xstate", "npm:yaml"]
}
```
