# Subagent Extension

Provides the `subagent` tool — delegates tasks to specialized agents with isolated context.

## Modes

- **Single**: `{ agent: "name", task: "..." }`
- **Parallel**: `{ tasks: [{ agent, task }, ...] }` (up to 8 tasks, 4 concurrent)
- **Chain**: `{ chain: [{ agent, task: "... {previous} ..." }, ...] }` (sequential, `{previous}` replaced with prior output)

## Agent discovery

Agents are `.md` files with frontmatter (`name`, `description`, optional `tools`, `model`).

| Scope | Directory |
|---|---|
| `user` (default) | `~/.pi/agent/agents/` |
| `project` | `.pi/agents/` (nearest parent) |
| `both` | Both directories (project overrides user) |

Project-local agents require user confirmation before execution.

## Rendering

- Shows agent name, status, tool call count, and final output
- Collapsed view: brief preview; expanded (Ctrl+O): full markdown output
- Usage stats: token counts and cost per agent
