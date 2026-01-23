# ADR-0004: Agent Config Format

## Status

Accepted (2026-01-23)

## Context

rawko-sdk needs a mechanism for defining agent configurations that specify:

- Agent identity and purpose
- System prompts for LLM behavior
- Available tools and their restrictions
- State transition rules
- Execution constraints (timeouts, iteration limits)

The original Rust rawko defined agents in code with CUE configuration. For rawko-sdk, we want:

- User-customizable agents without code changes
- Hot-reloadable configurations during development
- Clear separation between agent logic and orchestration
- Human-readable formats that are easy to version control

## Decision

Load FSM states and agent configurations from **`.rawko/agents/`** directory using **YAML** or **Markdown** formats.

### Configuration Locations

```
.rawko/
├── config.yaml          # Global rawko configuration
└── agents/
    ├── planner.yaml     # Planning agent (YAML format)
    ├── developer.md     # Developer agent (Markdown format)
    ├── tester.yaml      # Testing agent
    └── reviewer.yaml    # Review agent
```

### YAML Format

Primary format for structured configuration:

```yaml
name: planner
displayName: Planning Agent
whenToUse: |
  Analyze tasks and create implementation plans.
  Use at task start or when replanning is needed.

systemPrompt: |
  # Planning Mode

  You are analyzing a software task and creating a detailed plan.
  Focus on understanding requirements and producing actionable steps.

  ## Guidelines
  - Read files and explore code structure (READ-ONLY)
  - Do NOT modify files or run builds
  - Create numbered implementation steps

tools:
  allowed: [Read, Glob, Grep, Bash]
  blocked: [Write, Edit]
  bashFilter:
    allowedCommands: [ls, cat, head, git, find]
    blockedPatterns: ["rm ", "mv ", "> ", ">>"]

transitions:
  onSuccess: developer
  onFailure: planner
  onMaxIterations: developer

limits:
  maxIterations: 5
  timeout: 60000
```

### Markdown Format

Alternative format with YAML frontmatter for documentation-heavy agents:

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

Use this agent for implementing code changes based on the plan.

## When to Use

- After planning is complete
- When code modifications are required
- For creating new files

## System Prompt

You are implementing code changes according to the plan. Follow best practices and write clean, maintainable code.

### Guidelines

1. Follow the plan step by step
2. Write tests for new functionality
3. Commit changes with clear messages
```

## Consequences

### Positive

- **User customizable** - Add/modify agents without touching source code
- **Hot-reloadable** - Watch for changes during development
- **Version controlled** - Agent configs tracked alongside code
- **Portable** - Share agent configurations across projects
- **Two formats** - YAML for structure, Markdown for documentation
- **Self-documenting** - `whenToUse` field helps arbiter select agents

### Negative

- **Schema validation** - Need runtime validation of YAML/Markdown structure
- **Format complexity** - Supporting two formats increases parsing code
- **Discoverability** - Users must know to look in `.rawko/agents/`
- **Merge conflicts** - YAML can be tricky to merge in version control

## Alternatives Considered

### Code-Based Configuration (TypeScript)

**Approach**: Define agents as TypeScript modules

```typescript
// .rawko/agents/planner.ts
export default {
  name: "planner",
  systemPrompt: `...`,
  tools: ["Read", "Glob"],
} satisfies AgentConfig;
```

**Pros**: Type checking, IDE support, can include functions
**Cons**: Requires Deno to import, harder to edit for non-developers

**Rejected because**: YAML is more accessible for users who want to customize agents without TypeScript knowledge.

### JSON Format

**Approach**: Use JSON for configuration

**Pros**: Universal support, strict syntax
**Cons**: No comments, verbose, poor multiline string support

**Rejected because**: System prompts are multiline text; YAML's `|` block scalars are much cleaner than JSON escape sequences.

### CUE (Continue from rawko)

**Approach**: Use CUE configuration language

**Pros**: Powerful type system, validation built-in, inheritance
**Cons**: Learning curve, additional tooling required, less familiar

**Rejected because**: YAML is more widely known; CUE's power isn't needed for agent configs.

### Single Config File

**Approach**: Define all agents in one large `.rawko/config.yaml`

**Pros**: Single file to manage
**Cons**: Gets unwieldy, harder to collaborate, no separation of concerns

**Rejected because**: Separate files per agent are easier to manage and enable parallel editing.

## Implementation Notes

### Config Loading

```typescript
// src/config/loader.ts
import { parse as parseYaml } from "npm:yaml";
import { extract as extractFrontmatter } from "std/front_matter/yaml.ts";

async function loadAgentConfig(path: string): Promise<AgentConfig> {
  const content = await Deno.readTextFile(path);

  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return parseYaml(content) as AgentConfig;
  }

  if (path.endsWith(".md")) {
    const { attrs, body } = extractFrontmatter(content);
    return {
      ...attrs,
      systemPrompt: extractSystemPrompt(body),
    } as AgentConfig;
  }

  throw new Error(`Unsupported config format: ${path}`);
}

async function loadAllAgents(directory: string): Promise<Map<string, AgentConfig>> {
  const agents = new Map<string, AgentConfig>();

  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && /\.(ya?ml|md)$/.test(entry.name)) {
      const config = await loadAgentConfig(`${directory}/${entry.name}`);
      agents.set(config.name, config);
    }
  }

  return agents;
}
```

### Schema Validation

```typescript
// Using Zod for runtime validation
import { z } from "npm:zod";

const ToolFilterSchema = z.object({
  allowed: z.array(z.string()).optional(),
  blocked: z.array(z.string()).optional(),
  bashFilter: z.object({
    allowedCommands: z.array(z.string()).optional(),
    blockedPatterns: z.array(z.string()).optional(),
  }).optional(),
});

const AgentConfigSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  whenToUse: z.string().optional(),
  systemPrompt: z.string(),
  tools: ToolFilterSchema.optional(),
  transitions: z.object({
    onSuccess: z.string(),
    onFailure: z.string().optional(),
    onMaxIterations: z.string().optional(),
  }),
  limits: z.object({
    maxIterations: z.number().positive().optional(),
    timeout: z.number().positive().optional(),
  }).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
```

### Hot Reloading

```typescript
// Watch for agent config changes during development
async function watchAgents(directory: string, onChange: (agents: Map<string, AgentConfig>) => void) {
  const watcher = Deno.watchFs(directory);

  for await (const event of watcher) {
    if (event.kind === "modify" || event.kind === "create") {
      const agents = await loadAllAgents(directory);
      onChange(agents);
    }
  }
}
```

### Markdown System Prompt Extraction

For Markdown format, the system prompt is extracted from specific headings:

```typescript
function extractSystemPrompt(markdown: string): string {
  // Find ## System Prompt section
  const match = markdown.match(/## System Prompt\n\n([\s\S]*?)(?=\n## |$)/);
  if (match) {
    return match[1].trim();
  }

  // Fallback: use entire body after frontmatter
  return markdown.trim();
}
```

See [SPEC-0004: Agent Config Schema](../specs/0004-agent-config-schema.md) for complete schema specification.
