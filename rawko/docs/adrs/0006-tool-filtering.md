# ADR-0006: Mode-Based Tool Filtering

## Status

Accepted (2026-01-23)

## Context

Different agents in rawko-sdk have different responsibilities and risk profiles:

| Agent | Purpose | Risk Level |
|-------|---------|------------|
| Planner | Analyze code, create plans | Low (read-only) |
| Developer | Write and modify code | High (writes files) |
| Tester | Run tests, fix failures | Medium (executes commands) |
| Reviewer | Analyze code quality | Low (read-only) |

Giving all agents access to all tools creates risks:
- Planning agent accidentally modifying files
- Reviewer executing destructive commands
- Unintended side effects during analysis phases

The principle of least privilege suggests each agent should only have access to tools necessary for its role.

## Decision

Implement **mode-based tool filtering** where available tools are defined per-agent in YAML configuration.

### Filtering Levels

1. **Tool-level**: Entire tools allowed/blocked (Read, Write, Edit, Bash)
2. **Command-level**: Bash commands filtered by allowlist/blocklist
3. **Pattern-level**: Regex patterns to block dangerous operations

### Default Tool Sets by Agent Type

```yaml
# Planning agent - read-only analysis
planner:
  tools:
    allowed: [Read, Glob, Grep, Bash]
    blocked: [Write, Edit]
    bashFilter:
      allowedCommands: [ls, cat, head, tail, find, git, tree, wc]
      blockedPatterns: ["rm ", "mv ", "> ", ">> "]

# Developer agent - full access with safety rails
developer:
  tools:
    allowed: [Read, Write, Edit, Glob, Grep, Bash]
    bashFilter:
      blockedPatterns: ["rm -rf /", "sudo ", "chmod 777"]

# Tester agent - execute tests, limited writes for fixes
tester:
  tools:
    allowed: [Read, Edit, Glob, Grep, Bash]
    blocked: [Write]  # Can edit but not create new files
    bashFilter:
      allowedCommands: [npm, yarn, pnpm, deno, cargo, go, pytest, jest]

# Reviewer agent - read-only analysis
reviewer:
  tools:
    allowed: [Read, Glob, Grep]
    blocked: [Write, Edit, Bash]
```

## Consequences

### Positive

- **Security by default** - Agents can't exceed their intended scope
- **Predictable behavior** - Users know what each agent can do
- **Error prevention** - Catches accidental destructive operations
- **Configurability** - Users can customize tool access per project
- **Auditability** - Clear record of what tools each agent used

### Negative

- **Complexity** - Additional layer of permission checking
- **Potential frustration** - Agent may be blocked from legitimate operations
- **Configuration overhead** - Users must understand tool filtering
- **Performance** - Command filtering adds parsing overhead

## Alternatives Considered

### No Filtering (Full Access)

**Approach**: All agents have access to all tools

**Pros**: Simple, no permission errors, maximum flexibility
**Cons**: No safety rails, accidents possible, violates least privilege

**Rejected because**: Risk of unintended side effects outweighs simplicity benefits.

### User Confirmation for Dangerous Operations

**Approach**: Prompt user before dangerous commands

**Pros**: User maintains control, full agent capability
**Cons**: Interrupts automation, poor UX, user fatigue leads to rubber-stamping

**Rejected because**: Goal is autonomous operation; constant prompts defeat the purpose.

### Sandbox Execution

**Approach**: Run agents in isolated environments (containers, VMs)

**Pros**: Strong isolation, can allow anything safely
**Cons**: Complex setup, performance overhead, file sync issues

**Rejected because**: Overkill for most use cases; tool filtering is simpler and sufficient.

### Static Analysis of Commands

**Approach**: Analyze command intent before execution

**Pros**: More intelligent than pattern matching
**Cons**: Complex implementation, false positives/negatives

**Noted for future**: Could enhance pattern matching with static analysis later.

## Implementation Notes

### Tool Registry

```typescript
// src/tools/registry.ts
interface ToolRegistry {
  allTools: Map<string, ToolDefinition>;
  getToolsForAgent(agent: AgentConfig): ToolDefinition[];
}

class DefaultToolRegistry implements ToolRegistry {
  allTools = new Map<string, ToolDefinition>([
    ["Read", readTool],
    ["Write", writeTool],
    ["Edit", editTool],
    ["Glob", globTool],
    ["Grep", grepTool],
    ["Bash", bashTool],
    ["WebFetch", webFetchTool],
    ["WebSearch", webSearchTool],
  ]);

  getToolsForAgent(agent: AgentConfig): ToolDefinition[] {
    const toolsConfig = agent.tools ?? {};
    let tools = [...this.allTools.values()];

    // Filter by allowed list
    if (toolsConfig.allowed?.length) {
      const allowedSet = new Set(toolsConfig.allowed);
      tools = tools.filter((t) => allowedSet.has(t.name));
    }

    // Remove blocked tools
    if (toolsConfig.blocked?.length) {
      const blockedSet = new Set(toolsConfig.blocked);
      tools = tools.filter((t) => !blockedSet.has(t.name));
    }

    // Wrap Bash tool with filtering
    if (toolsConfig.bashFilter) {
      tools = tools.map((t) =>
        t.name === "Bash" ? this.wrapBashTool(t, toolsConfig.bashFilter!) : t
      );
    }

    return tools;
  }

  private wrapBashTool(tool: ToolDefinition, filter: BashFilter): ToolDefinition {
    const originalHandler = tool.handler!;

    return {
      ...tool,
      handler: async (input: { command: string; description?: string }) => {
        const validation = this.validateBashCommand(input.command, filter);

        if (!validation.allowed) {
          return {
            output: `Command blocked: ${validation.reason}`,
            isError: true,
          };
        }

        return originalHandler(input);
      },
    };
  }

  private validateBashCommand(
    command: string,
    filter: BashFilter
  ): { allowed: boolean; reason?: string } {
    // Extract base command (first word, handling paths)
    const baseCommand = command.trim().split(/\s+/)[0].split("/").pop()!;

    // Check allowlist
    if (filter.allowedCommands?.length) {
      if (!filter.allowedCommands.includes(baseCommand)) {
        return {
          allowed: false,
          reason: `Command '${baseCommand}' is not in allowed list: ${filter.allowedCommands.join(", ")}`,
        };
      }
    }

    // Check blocked patterns
    if (filter.blockedPatterns?.length) {
      for (const pattern of filter.blockedPatterns) {
        if (new RegExp(pattern, "i").test(command)) {
          return {
            allowed: false,
            reason: `Command matches blocked pattern: ${pattern}`,
          };
        }
      }
    }

    return { allowed: true };
  }
}
```

### Bash Filter Configuration

```typescript
interface BashFilter {
  /** Commands that are allowed (if set, only these can run) */
  allowedCommands?: string[];

  /** Regex patterns that block execution */
  blockedPatterns?: string[];

  /** Working directory restrictions */
  allowedPaths?: string[];

  /** Environment variables to block */
  blockedEnvVars?: string[];
}
```

### Common Blocked Patterns

```typescript
const DANGEROUS_PATTERNS = [
  // Destructive file operations
  "rm -rf /",
  "rm -rf ~",
  "rm -rf \\*",

  // Privilege escalation
  "sudo ",
  "su -",
  "doas ",

  // Network exfiltration
  "curl.*\\|.*sh",
  "wget.*\\|.*sh",

  // Permission changes
  "chmod 777",
  "chmod -R 777",

  // History/credential access
  "cat.*history",
  "cat.*password",
  "cat.*secret",
  "cat.*credential",
  "cat.*/etc/shadow",

  // Disk operations
  "dd if=",
  "mkfs",
  "fdisk",

  // Process manipulation
  "kill -9 1",
  "killall",
];
```

### Escape Hatch

For power users who need to bypass filtering:

```yaml
# .rawko/config.yaml
constraints:
  allowToolFilterOverride: true  # Dangerous!
```

```typescript
// Usage in agent config
developer:
  tools:
    # Override: allow all tools regardless of defaults
    override: true
```

### Logging and Auditing

All tool invocations are logged for auditability:

```typescript
interface ToolInvocation {
  timestamp: Date;
  agent: string;
  tool: string;
  input: unknown;
  allowed: boolean;
  blockReason?: string;
  output?: unknown;
  duration: number;
}

function logToolInvocation(invocation: ToolInvocation): void {
  // Write to audit log
  console.log(JSON.stringify({
    ...invocation,
    timestamp: invocation.timestamp.toISOString(),
  }));
}
```

### Error Messages

When a tool is blocked, provide helpful feedback:

```typescript
function formatBlockedToolError(
  agent: string,
  tool: string,
  reason: string
): string {
  return `
[Tool Blocked]
Agent '${agent}' attempted to use '${tool}' but it is not allowed.
Reason: ${reason}

To allow this tool, update the agent configuration:
  .rawko/agents/${agent}.yaml

Example:
  tools:
    allowed: [..., ${tool}]
`.trim();
}
```

See [SPEC-0004: Agent Config Schema](../specs/0004-agent-config-schema.md) for complete tool configuration schema.
