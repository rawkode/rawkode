# Subagent Extension (Local Copy)

Copied from `pi-mono/packages/coding-agent/examples/extensions/subagent/`.

Provides the `subagent` tool used by council fan-out in `.pi/extensions/modes/index.ts`.

Key behavior used by modes extension:
- `subagent` parallel tasks (`tasks: [{agent, task}, ...]`)
- `agentScope: "both"` to include `.pi/agents`
- `confirmProjectAgents: false` for non-interactive council automation
