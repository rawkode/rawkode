# SPEC-0006: Agent Configuration (Markdown Format)

## Abstract

This specification defines the Markdown with YAML frontmatter format for agent configuration files, enabling readable, maintainable agent definitions without multiline YAML complexity.

## Motivation

Agent configuration needs to be:
- Easy to read and edit
- Support complex system prompts
- Include guidance and examples
- Avoid YAML multiline string escaping
- Version-control friendly

Markdown with YAML frontmatter achieves all this.

## Detailed Design

### File Format

Agent definitions are Markdown files in `.rawko/agents/` with YAML frontmatter.

**File location**: `.rawko/agents/{name}.md`

**Structure**:
```markdown
---
# YAML frontmatter with configuration
---

# Markdown body with system prompt and guidance
```

### Frontmatter Schema

```typescript
interface AgentFrontmatter {
  /** Unique identifier for agent */
  name: string; // e.g., "developer"

  /** Human-readable display name */
  displayName: string; // e.g., "Development Agent"

  /** When to use this agent (for arbiter) */
  whenToUse: string;

  /** Tool access configuration */
  tools?: {
    allowed?: string[]; // [Read, Write, Edit, Bash]
    blocked?: string[];
    bashFilter?: {
      allowedCommands?: string[];
      blockedPatterns?: string[];
    };
  };

  /** State transitions */
  transitions: {
    onSuccess: string; // Next agent on success
    onFailure?: string; // Next agent on failure (defaults to self)
    onMaxIterations?: string; // Next agent when max iterations reached
  };

  /** Execution constraints */
  limits?: {
    maxIterations?: number;
    timeout?: number;
    maxTokens?: number;
  };

  /** Optional provider override */
  provider?: {
    name: "claude" | "copilot";
    model?: string;
  };

  /** Optional metadata */
  metadata?: {
    category?: string;
    priority?: number;
    tags?: string[];
    [key: string]: unknown;
  };
}
```

### Markdown Body

The body contains the system prompt and additional guidance.

**Typical structure**:

```markdown
# Agent Name

One-line description.

## System Prompt

Your actual system prompt goes here. This section (between `## System Prompt` and next heading) becomes the LLM system prompt.

Can include:
- Multi-paragraph explanations
- Code blocks
- Lists
- Anything markdown supports

## Responsibilities

Optional: Additional context for the agent

## Constraints

Optional: Limitations and boundaries

## Guidelines

Optional: Best practices

## When Stuck

Optional: Troubleshooting advice

## Output Format

Optional: Expected output format
```

### Complete Example: Developer Agent

```markdown
---
name: developer
displayName: Development Agent

whenToUse: |
  Use this agent when:
  - A plan exists and implementation is needed
  - Code modifications are required
  - Creating new files or components
  - Fixing bugs identified during testing

tools:
  allowed: [Read, Write, Edit, Glob, Grep, Bash]
  bashFilter:
    allowedCommands: [ls, cat, find, git, npm, pnpm, node, tsc]
    blockedPatterns: ["rm -rf /", "rm -rf ~", "sudo ", "chmod 777"]

transitions:
  onSuccess: tester
  onFailure: developer
  onMaxIterations: reviewer

limits:
  maxIterations: 20
  timeout: 300000
  maxTokens: 8192

metadata:
  category: implementation
  priority: 2
  tags: [code, implementation, hands-on]
---

# Development Agent

You are implementing code changes according to a detailed plan.

## System Prompt

Your job is to transform a plan into working code. Write clean, maintainable code that follows the project's existing patterns and conventions.

### Your Responsibilities

1. **Follow the plan step-by-step**
   - Work through each numbered step
   - Don't skip or combine steps
   - Complete one step before moving to next

2. **Write quality code**
   - Follow existing code patterns in the project
   - Use consistent naming conventions
   - Handle edge cases and errors properly
   - Keep functions focused and reasonably sized

3. **Make incremental changes**
   - Prefer small focused changes over large rewrites
   - Test changes as you go when practical
   - Commit logical units of work

4. **Update documentation**
   - Add comments only where logic is non-obvious
   - Update README if behavior changes
   - Don't over-document trivial code

### Constraints

- **Read the plan**: Every step in the plan must be addressed
- **No scope creep**: Implement what's asked, not extras
- **Existing patterns**: Follow the project's established conventions
- **Error handling**: Always handle errors, don't let them silently fail

### Guidelines

- **Edit over create**: Prefer editing existing files over creating new ones
- **Minimal changes**: Only change what's necessary
- **Test-aware**: Consider how changes will be tested
- **Clear commits**: Each commit should be a complete logical unit

### When Stuck

If you encounter issues:

1. **Read error messages carefully** - They usually contain the actual problem
2. **Check if dependencies are installed** - `npm list` or similar
3. **Look for similar patterns** - How is this done elsewhere in the codebase?
4. **Test incrementally** - Run tests after each change
5. **If truly blocked** - Explain the issue clearly and ask for guidance

### Output Format

After completing work, summarize:
- What was implemented
- Files that were modified
- Any issues encountered
- What should be tested next

---

## Integration Notes

This agent works well with:
- **Planner** - Provides detailed plans to follow
- **Tester** - Validates implemented code
- **Reviewer** - Checks code quality

## Common Patterns in This Codebase

- TypeScript with strict mode enabled
- Express.js middleware pattern
- Error handling with try/catch
- Async/await for async operations
```

### Minimal Agent Example

```markdown
---
name: researcher
displayName: Research Agent

whenToUse: |
  Use for gathering information about code/requirements.

tools:
  allowed: [Read, Glob, Grep]
  blocked: [Write, Edit, Bash]

transitions:
  onSuccess: developer
  onFailure: researcher

limits:
  maxIterations: 10
  timeout: 60000
---

# Research Agent

Explore and understand the codebase and requirements without making changes.

## System Prompt

Your task is to gather information. Read files, understand structure, identify patterns.

Return your findings in clear, organized format.
```

### Parser Implementation

```typescript
import { parse as parseYaml } from "npm:yaml";
import { extract as extractFrontmatter } from "std/front_matter/yaml.ts";

/**
 * Load an agent from markdown file.
 */
async function loadAgentFromMarkdown(path: string): Promise<Agent> {
  const content = await Deno.readTextFile(path);

  // Extract frontmatter and body
  const { attrs, body } = extractFrontmatter(content);

  // Validate frontmatter
  const frontmatter = validateAgentFrontmatter(attrs);

  // Extract system prompt from markdown body
  const systemPrompt = extractSystemPrompt(body);

  return {
    ...frontmatter,
    systemPrompt,
    markdownBody: body, // For reference/debugging
  };
}

/**
 * Extract system prompt from markdown body.
 * Looks for ## System Prompt section, or uses entire body if not found.
 */
function extractSystemPrompt(body: string): string {
  // Try to find "## System Prompt" section
  const match = body.match(/## System Prompt\n\n([\s\S]*?)(?=\n## |\n---|\z)/i);

  if (match) {
    return match[1].trim();
  }

  // Fallback: remove headers and metadata, use what's left
  return body
    .replace(/^# .*$/m, "") // Remove h1
    .replace(/## [^\n]+\n([\s\S]*?)(?=\n## |$)/g, "") // Remove other sections
    .trim();
}

/**
 * Validate agent frontmatter against schema.
 */
function validateAgentFrontmatter(attrs: unknown): AgentFrontmatter {
  const result = AgentFrontmatterSchema.safeParse(attrs);

  if (!result.success) {
    throw new Error(`Invalid agent config: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Zod schema for validation.
 */
const AgentFrontmatterSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/i),
  displayName: z.string().default((ctx) => ctx.data.name),
  whenToUse: z.string(),

  tools: z
    .object({
      allowed: z.array(z.string()).optional(),
      blocked: z.array(z.string()).optional(),
      bashFilter: z
        .object({
          allowedCommands: z.array(z.string()).optional(),
          blockedPatterns: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),

  transitions: z.object({
    onSuccess: z.string(),
    onFailure: z.string().optional(),
    onMaxIterations: z.string().optional(),
  }),

  limits: z
    .object({
      maxIterations: z.number().int().positive().optional(),
      timeout: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),

  provider: z
    .object({
      name: z.enum(["claude", "copilot"]),
      model: z.string().optional(),
    })
    .optional(),

  metadata: z.record(z.unknown()).optional(),
});
```

### Loading All Agents

```typescript
/**
 * Load all agent configurations from .rawko/agents/
 */
async function loadAllAgents(
  directory: string = ".rawko/agents"
): Promise<Map<string, Agent>> {
  const agents = new Map<string, Agent>();

  try {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      try {
        const path = `${directory}/${entry.name}`;
        const agent = await loadAgentFromMarkdown(path);
        agents.set(agent.name, agent);
      } catch (error) {
        console.error(`Failed to load agent from ${entry.name}:`, error);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // agents directory doesn't exist yet
      return agents;
    }
    throw error;
  }

  return agents;
}

/**
 * Validate agent configuration set.
 */
function validateAgentSet(agents: Map<string, Agent>): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [name, agent] of agents) {
    // Check transition targets exist
    const targets = [
      agent.transitions.onSuccess,
      agent.transitions.onFailure,
      agent.transitions.onMaxIterations,
    ].filter(Boolean);

    for (const target of targets) {
      if (!agents.has(target!)) {
        errors.push({
          agent: name,
          error: `Transition target '${target}' not found`,
        });
      }
    }

    // Check tool names are valid
    if (agent.tools) {
      const validTools = [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        // Add custom tools here
      ];

      for (const tool of agent.tools.allowed || []) {
        if (!validTools.includes(tool)) {
          errors.push({
            agent: name,
            error: `Unknown tool '${tool}' in allowed list`,
          });
        }
      }
    }
  }

  return errors;
}
```

## Examples

### Example 1: Planner Agent

```markdown
---
name: planner
displayName: Planning Agent

whenToUse: |
  Use this agent when:
  - Starting a new task that needs analysis
  - Replanning after failures
  - Creating implementation roadmap

tools:
  allowed: [Read, Glob, Grep]
  blocked: [Write, Edit, Bash]
  bashFilter:
    allowedCommands: [ls, cat, find, git]
    blockedPatterns: ["rm ", "mv ", "> "]

transitions:
  onSuccess: developer
  onFailure: planner
  onMaxIterations: developer

limits:
  maxIterations: 5
  timeout: 60000
  maxTokens: 4096
---

# Planning Agent

You analyze tasks and create detailed implementation plans.

## System Prompt

Analyze the task and create a step-by-step implementation plan.

### Your Responsibilities

1. Understand the task completely
2. Explore the codebase
3. Create numbered, specific steps
4. Identify risks and dependencies

### Constraints

- READ-ONLY access only
- No modifications
- Analysis only
```

### Example 2: Tester Agent

```markdown
---
name: tester
displayName: Testing Agent

whenToUse: |
  Use when code is implemented and needs validation.

tools:
  allowed: [Read, Bash, Grep]
  blocked: [Write, Edit]

transitions:
  onSuccess: reviewer
  onFailure: developer

limits:
  maxIterations: 15
  timeout: 120000
---

# Tester Agent

Validate that code works correctly through testing.

## System Prompt

Run tests, identify failures, report issues clearly.
```

## Advantages Over YAML-Only

| Aspect | YAML Only | Markdown + Frontmatter |
|--------|-----------|------------------------|
| Readability | Hard (multiline escaping) | Easy (natural markdown) |
| Comments | Limited | Extensive markdown sections |
| Examples | Must be inline strings | Code blocks with syntax highlighting |
| Versioning | Difficult diffs | Clean diffs |
| IDE support | Basic YAML | Full markdown + frontmatter |
| Editing | Text editor | Any markdown editor |

## Migration from YAML

Convert existing YAML agents:

```typescript
async function migrateYamlToMarkdown(yamlPath: string): Promise<string> {
  // Parse YAML
  const yaml = await Deno.readTextFile(yamlPath);
  const config = parseYaml(yaml);

  // Extract frontmatter
  const {
    name,
    displayName,
    whenToUse,
    systemPrompt,
    tools,
    transitions,
    limits,
  } = config;

  // Build markdown
  let markdown = `---\n`;
  markdown += `name: ${name}\n`;
  markdown += `displayName: ${displayName}\n`;
  markdown += `whenToUse: |\n${indent(whenToUse, 2)}\n`;

  if (tools) {
    markdown += `tools:\n${indent(YAML.stringify(tools), 2)}`;
  }

  markdown += `transitions:\n${indent(YAML.stringify(transitions), 2)}`;

  if (limits) {
    markdown += `limits:\n${indent(YAML.stringify(limits), 2)}`;
  }

  markdown += `---\n\n`;
  markdown += `# ${displayName}\n\n`;
  markdown += `## System Prompt\n\n`;
  markdown += `${systemPrompt}\n`;

  return markdown;
}
```

## Drawbacks

1. **Parsing complexity** - Must handle both frontmatter and markdown body
2. **Consistency** - Markdown body structure not enforced (users might not follow convention)
3. **Extraction fragility** - System prompt extraction relies on heading conventions
4. **Tool limitations** - Some YAML editors won't properly handle embedded markdown

## Unresolved Questions

1. **Markdown validation** - Should we validate markdown structure?
2. **Rendering** - Should we generate HTML docs from agent files?
3. **Inheritance** - Should agents extend other agents?
4. **Conditional tools** - Tools enabled based on context?
5. **Version conflicts** - How to handle agent updates across runs?
