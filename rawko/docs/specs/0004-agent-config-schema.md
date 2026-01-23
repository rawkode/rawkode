# SPEC-0004: Agent Config Schema

## Abstract

This specification defines the YAML and Markdown configuration schema for rawko-sdk agent definitions, including all fields, validation rules, and processing logic.

## Motivation

Agent configurations are the primary mechanism for customizing rawko-sdk behavior. A well-defined schema enables:

- Validation of user-provided configurations
- IDE autocompletion and linting
- Documentation generation
- Consistent agent behavior across projects

## Detailed Design

### File Locations

Agent configurations are loaded from:

```
.rawko/
├── config.yaml          # Global configuration
└── agents/
    ├── *.yaml           # YAML format agents
    └── *.md             # Markdown format agents
```

### YAML Schema

#### Complete Agent Configuration

```yaml
# Required: Unique identifier for the agent
name: planner

# Optional: Human-readable display name
displayName: Planning Agent

# Optional: Description for arbiter to understand when to use this agent
whenToUse: |
  Use this agent when:
  - Starting a new task
  - Replanning after failures
  - Creating implementation roadmaps

# Required: System prompt for the LLM
systemPrompt: |
  # Planning Mode

  You are analyzing a software task and creating a detailed implementation plan.

  ## Your Responsibilities
  - Read and understand the codebase
  - Identify files that need modification
  - Create numbered implementation steps
  - Identify potential risks

  ## Constraints
  - Do NOT modify any files
  - Do NOT execute build commands
  - Only read and analyze

# Optional: Tool access configuration
tools:
  # Tools explicitly allowed for this agent
  allowed:
    - Read
    - Glob
    - Grep
    - Bash

  # Tools explicitly blocked (overrides allowed)
  blocked:
    - Write
    - Edit

  # Bash command filtering (only applies if Bash is allowed)
  bashFilter:
    # Commands that can be executed
    allowedCommands:
      - ls
      - cat
      - head
      - tail
      - find
      - git
      - tree

    # Patterns that block command execution (regex)
    blockedPatterns:
      - "rm "
      - "mv "
      - "> "
      - ">> "
      - "sudo "
      - "chmod "

# Required: State transition rules
transitions:
  # Agent to transition to on successful completion
  onSuccess: developer

  # Agent to transition to on failure (optional, defaults to self)
  onFailure: planner

  # Agent to transition to when max iterations reached (optional)
  onMaxIterations: developer

  # Custom transitions based on output (optional)
  custom:
    - condition: "output contains 'needs research'"
      target: researcher

# Optional: Execution constraints
limits:
  # Maximum iterations before forced transition
  maxIterations: 5

  # Timeout in milliseconds
  timeout: 60000

  # Maximum tokens for responses (overrides global)
  maxTokens: 4096

# Optional: Provider override for this agent
provider:
  name: claude
  model: claude-sonnet-4

# Optional: Arbitrary metadata
metadata:
  category: planning
  priority: 1
  tags:
    - read-only
    - analysis
```

### TypeScript Schema Definition

```typescript
import { z } from "npm:zod";

/**
 * Bash command filtering configuration.
 */
const BashFilterSchema = z.object({
  /** Commands that are allowed to execute */
  allowedCommands: z.array(z.string()).optional(),

  /** Regex patterns that block execution if matched */
  blockedPatterns: z.array(z.string()).optional(),
});

/**
 * Tool access configuration.
 */
const ToolsConfigSchema = z.object({
  /** Tools explicitly allowed */
  allowed: z.array(z.string()).optional(),

  /** Tools explicitly blocked (overrides allowed) */
  blocked: z.array(z.string()).optional(),

  /** Bash-specific filtering */
  bashFilter: BashFilterSchema.optional(),
});

/**
 * Custom transition rule.
 */
const CustomTransitionSchema = z.object({
  /** Condition to evaluate (simple string matching for now) */
  condition: z.string(),

  /** Target agent name */
  target: z.string(),
});

/**
 * State transition configuration.
 */
const TransitionsSchema = z.object({
  /** Agent on successful completion */
  onSuccess: z.string(),

  /** Agent on failure (defaults to self for retry) */
  onFailure: z.string().optional(),

  /** Agent when max iterations reached */
  onMaxIterations: z.string().optional(),

  /** Custom transition rules */
  custom: z.array(CustomTransitionSchema).optional(),
});

/**
 * Execution limits.
 */
const LimitsSchema = z.object({
  /** Maximum execution iterations */
  maxIterations: z.number().int().positive().optional(),

  /** Timeout in milliseconds */
  timeout: z.number().int().positive().optional(),

  /** Maximum tokens for responses */
  maxTokens: z.number().int().positive().optional(),
});

/**
 * Provider override.
 */
const ProviderOverrideSchema = z.object({
  /** Provider name */
  name: z.enum(["claude", "copilot"]),

  /** Model identifier */
  model: z.string().optional(),
});

/**
 * Complete agent configuration schema.
 */
export const AgentConfigSchema = z.object({
  /** Unique agent identifier */
  name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/i, {
    message: "Name must start with a letter and contain only letters, numbers, hyphens, and underscores",
  }),

  /** Human-readable display name */
  displayName: z.string().optional(),

  /** When to use this agent (for arbiter) */
  whenToUse: z.string().optional(),

  /** System prompt for the LLM */
  systemPrompt: z.string().min(1),

  /** Tool access configuration */
  tools: ToolsConfigSchema.optional(),

  /** State transitions */
  transitions: TransitionsSchema,

  /** Execution limits */
  limits: LimitsSchema.optional(),

  /** Provider override */
  provider: ProviderOverrideSchema.optional(),

  /** Arbitrary metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
```

### Markdown Format

For documentation-heavy agents, Markdown format is supported with YAML frontmatter:

```markdown
---
name: developer
displayName: Development Agent
tools:
  allowed: [Read, Write, Edit, Glob, Grep, Bash]
transitions:
  onSuccess: tester
  onFailure: developer
limits:
  maxIterations: 20
  timeout: 300000
---

# Development Agent

Implements code changes according to the plan.

## When to Use

Use this agent when:
- The plan has been created and approved
- Code modifications are required
- Creating new files or components

## System Prompt

You are a skilled software developer implementing changes according to a plan.

### Your Responsibilities
- Follow the implementation plan step by step
- Write clean, maintainable code
- Add appropriate tests
- Handle edge cases

### Guidelines
- Prefer editing existing files over creating new ones
- Follow existing code patterns and conventions
- Add comments only where necessary
- Run tests after significant changes
```

#### Markdown Processing Rules

1. **Frontmatter**: YAML between `---` markers provides structured config
2. **System Prompt**: Content under `## System Prompt` heading becomes systemPrompt
3. **When to Use**: Content under `## When to Use` becomes whenToUse
4. **Fallback**: If no `## System Prompt` heading, entire body becomes systemPrompt

### Built-in Tool Names

```typescript
/**
 * Standard tools that can be referenced in agent configs.
 */
const BUILTIN_TOOLS = [
  "Read",      // Read file contents
  "Write",     // Write/create files
  "Edit",      // Edit existing files
  "Glob",      // Find files by pattern
  "Grep",      // Search file contents
  "Bash",      // Execute shell commands
  "WebFetch",  // Fetch web content
  "WebSearch", // Search the web
] as const;

type BuiltinTool = typeof BUILTIN_TOOLS[number];
```

### Tool Resolution

```typescript
/**
 * Resolve final tool set for an agent.
 */
function resolveTools(config: AgentConfig, allTools: ToolDefinition[]): ToolDefinition[] {
  const { allowed, blocked } = config.tools ?? {};

  let tools = allTools;

  // If allowed is specified, filter to only allowed
  if (allowed?.length) {
    tools = tools.filter((t) => allowed.includes(t.name));
  }

  // Remove blocked tools
  if (blocked?.length) {
    tools = tools.filter((t) => !blocked.includes(t.name));
  }

  // Apply bash filtering if present
  if (config.tools?.bashFilter) {
    tools = tools.map((t) => {
      if (t.name === "Bash") {
        return wrapBashTool(t, config.tools!.bashFilter!);
      }
      return t;
    });
  }

  return tools;
}

/**
 * Wrap Bash tool with filtering logic.
 */
function wrapBashTool(tool: ToolDefinition, filter: BashFilter): ToolDefinition {
  return {
    ...tool,
    handler: async (input: { command: string }) => {
      const { command } = input;

      // Check allowed commands
      if (filter.allowedCommands?.length) {
        const cmd = command.split(" ")[0];
        if (!filter.allowedCommands.includes(cmd)) {
          return {
            output: `Command '${cmd}' is not allowed in this mode`,
            isError: true,
          };
        }
      }

      // Check blocked patterns
      if (filter.blockedPatterns?.length) {
        for (const pattern of filter.blockedPatterns) {
          if (new RegExp(pattern).test(command)) {
            return {
              output: `Command blocked by pattern: ${pattern}`,
              isError: true,
            };
          }
        }
      }

      // Execute if allowed
      return tool.handler!(input);
    },
  };
}
```

### Config Loader

```typescript
import { parse as parseYaml } from "npm:yaml";
import { extract as extractFrontmatter } from "std/front_matter/yaml.ts";

/**
 * Load a single agent configuration from a file.
 */
async function loadAgentConfig(path: string): Promise<AgentConfig> {
  const content = await Deno.readTextFile(path);

  let rawConfig: unknown;

  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    rawConfig = parseYaml(content);
  } else if (path.endsWith(".md")) {
    rawConfig = parseMarkdownConfig(content);
  } else {
    throw new Error(`Unsupported config format: ${path}`);
  }

  // Validate against schema
  const result = AgentConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new Error(
      `Invalid agent config at ${path}: ${result.error.message}`
    );
  }

  return result.data;
}

/**
 * Parse Markdown format agent config.
 */
function parseMarkdownConfig(content: string): unknown {
  const { attrs, body } = extractFrontmatter(content);

  return {
    ...attrs,
    systemPrompt: extractSystemPrompt(body),
    whenToUse: extractWhenToUse(body) ?? attrs.whenToUse,
  };
}

/**
 * Extract system prompt from Markdown body.
 */
function extractSystemPrompt(body: string): string {
  // Find ## System Prompt section
  const match = body.match(
    /## System Prompt\n\n([\s\S]*?)(?=\n## |\n---|\z)/
  );
  if (match) {
    return match[1].trim();
  }

  // Fallback: remove known sections and use remainder
  const cleaned = body
    .replace(/# [^\n]+\n/, "")           // Remove h1
    .replace(/## When to Use[\s\S]*?(?=\n## |$)/, "")  // Remove when to use
    .trim();

  return cleaned || body.trim();
}

/**
 * Extract "when to use" description from Markdown body.
 */
function extractWhenToUse(body: string): string | undefined {
  const match = body.match(
    /## When to Use\n\n([\s\S]*?)(?=\n## |$)/
  );
  return match?.[1].trim();
}

/**
 * Load all agent configurations from a directory.
 */
async function loadAllAgents(
  directory: string
): Promise<Map<string, AgentConfig>> {
  const agents = new Map<string, AgentConfig>();

  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    if (!/\.(ya?ml|md)$/.test(entry.name)) continue;

    try {
      const config = await loadAgentConfig(`${directory}/${entry.name}`);
      agents.set(config.name, config);
    } catch (error) {
      console.error(`Failed to load agent from ${entry.name}:`, error);
    }
  }

  return agents;
}
```

### Validation Rules

1. **Name uniqueness**: Agent names must be unique within a project
2. **Transition targets**: All transition targets must reference valid agent names
3. **Tool names**: Tool names in `allowed`/`blocked` must be valid built-in or custom tools
4. **Circular transitions**: Warn (but allow) circular transition chains
5. **System prompt**: Must be non-empty string

```typescript
/**
 * Validate agent configurations as a set.
 */
function validateAgentSet(agents: Map<string, AgentConfig>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [name, config] of agents) {
    // Check transition targets exist
    const targets = [
      config.transitions.onSuccess,
      config.transitions.onFailure,
      config.transitions.onMaxIterations,
      ...(config.transitions.custom?.map((c) => c.target) ?? []),
    ].filter(Boolean);

    for (const target of targets) {
      if (!agents.has(target!)) {
        errors.push(`Agent '${name}' references unknown agent '${target}'`);
      }
    }

    // Warn about self-transitions on success
    if (config.transitions.onSuccess === name) {
      warnings.push(`Agent '${name}' transitions to itself on success (potential infinite loop)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

## Examples

### Minimal Agent

```yaml
name: simple
systemPrompt: You are a helpful assistant.
transitions:
  onSuccess: complete
```

### Read-Only Research Agent

```yaml
name: researcher
displayName: Research Agent
whenToUse: |
  Use for gathering information without modifying files.

systemPrompt: |
  You are researching a topic. Read files and search the web.
  Do NOT modify any files.

tools:
  allowed: [Read, Glob, Grep, WebSearch, WebFetch]
  blocked: [Write, Edit, Bash]

transitions:
  onSuccess: planner
  onFailure: researcher

limits:
  maxIterations: 10
  timeout: 120000
```

### Full-Access Developer Agent

```yaml
name: developer
displayName: Development Agent
whenToUse: |
  Implement code changes according to the plan.

systemPrompt: |
  # Development Mode

  Implement the planned changes. Write clean code.

tools:
  allowed: [Read, Write, Edit, Glob, Grep, Bash]
  bashFilter:
    blockedPatterns:
      - "rm -rf"
      - "sudo"

transitions:
  onSuccess: tester
  onFailure: developer
  onMaxIterations: reviewer

limits:
  maxIterations: 20
  timeout: 300000
  maxTokens: 8192
```

## Drawbacks

1. **Schema evolution** - Adding fields requires migration consideration
2. **Validation complexity** - Cross-agent validation adds processing
3. **Format ambiguity** - Two formats (YAML/Markdown) may confuse users
4. **Prompt injection** - User-provided system prompts could be malicious

## Unresolved Questions

1. **Inheritance** - Should agents be able to extend other agents?
2. **Variables** - Support for `${variable}` substitution in prompts?
3. **Conditional tools** - Tools enabled based on context?
4. **Remote agents** - Loading agent configs from URLs?
