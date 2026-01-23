# Convention: Agent Files (Markdown + YAML Frontmatter)

## Overview

Agent definitions use Markdown with YAML frontmatter, avoiding YAML's multiline string complexity while keeping configuration structured and system prompts readable.

**Format**: Markdown with YAML frontmatter  
**Location**: `.rawko/agents/{name}.md`  
**Parsing**: Extract frontmatter YAML + markdown body

## File Structure

```markdown
---
# YAML frontmatter with configuration
name: developer
displayName: Development Agent
whenToUse: |
  Use when implementing code according to a plan.
tools:
  allowed: [Read, Write, Edit]
  blocked: [Delete]
transitions:
  onSuccess: tester
  onFailure: developer
limits:
  maxIterations: 20
---

# Markdown body with system prompt and guidance
```

## Frontmatter Specification

### Required Fields

**name** (string, unique)
- Internal identifier
- Pattern: lowercase with hyphens or underscores
- Examples: `developer`, `code-reviewer`, `api_spec_writer`
- Used in state machine transitions

**displayName** (string)
- Human-readable name
- Examples: "Development Agent", "Code Reviewer"
- Shown in logs and UI

**whenToUse** (string or string[])
- Description of when arbiter should select this agent
- Examples:
  - `"Use for implementing code changes"`
  - `["When code modifications needed", "After planning"]`
- Used by arbiter to make decisions
- Can be multi-line (use YAML pipe `|`)

**transitions** (object)
- `onSuccess` (string, required): Next agent/state on success
- `onFailure` (string, optional): Next agent on failure (defaults to self)
- `onMaxIterations` (string, optional): Next agent when max iterations hit

### Optional Fields

**tools** (object)
```yaml
tools:
  allowed: [Read, Write, Bash]        # Can use these tools
  blocked: [Delete, Run]              # Cannot use (overrides allowed)
  bashFilter:
    allowedCommands: [npm, node]      # Only these bash commands
    blockedPatterns: ["rm -rf /"]     # Blocked patterns (regex)
```

**limits** (object)
```yaml
limits:
  maxIterations: 20        # How many iterations before forced transition
  timeout: 300000          # Timeout in milliseconds
  maxTokens: 8192          # Max tokens for LLM responses
```

**provider** (object)
```yaml
provider:
  name: claude             # "claude" or "copilot"
  model: claude-sonnet-4   # Specific model override
```

**metadata** (object)
```yaml
metadata:
  category: implementation   # Agent category
  priority: 2               # Priority order
  tags: [code, testing]     # Tags for organization
```

## Markdown Body

### System Prompt Section

The system prompt is extracted from markdown. Use the `## System Prompt` heading:

```markdown
## System Prompt

Your actual system prompt goes here.

This entire section becomes the LLM system prompt.

Can include multiple paragraphs...
```

**Extraction rule**: Everything between `## System Prompt` and the next `##` heading (or end of file) becomes the system prompt.

### Additional Sections

Optional sections provide context:

- **## Responsibilities**: What this agent is responsible for
- **## Constraints**: Limitations and boundaries
- **## Guidelines**: Best practices and recommendations
- **## When Stuck**: Troubleshooting if agent can't proceed
- **## Output Format**: Expected output format

### Full Example

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
    blockedPatterns: ["rm -rf /", "sudo ", "chmod 777"]

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

## Responsibilities

Same as system prompt section above.

## Constraints

Refer to system prompt.

## Guidelines

Refer to system prompt.

## When Stuck

If you encounter issues:

1. **Read error messages carefully** - They usually contain the actual problem
2. **Check if dependencies are installed** - `npm list` or similar
3. **Look for similar patterns** - How is this done elsewhere in the codebase?
4. **Test incrementally** - Run tests after each change
5. **If truly blocked** - Explain the issue clearly and ask for guidance

## Output Format

After completing work, summarize:
- What was implemented
- Files that were modified
- Any issues encountered
- What should be tested next
```

## System Prompt Best Practices

### DO

1. **Be specific**: "Implement code according to plan" not "write code"
2. **Include examples**: Show code patterns agents should follow
3. **List responsibilities**: Clear enumerated list of what agent does
4. **Set constraints**: What agent should NOT do
5. **Give guidance**: What to do when stuck
6. **Explain context**: Why this agent, when it runs

### DON'T

1. **Write vague prompts**: "Do good work" is not helpful
2. **Be too verbose**: Keep under 1000 words of system prompt
3. **Mix concerns**: One system prompt per agent
4. **Use multiline YAML strings**: Use markdown instead
5. **Assume context**: Explain even obvious things

## Agent File Organization

```
.rawko/agents/
├── planner.md              # Planning agent
├── developer.md            # Development agent
├── tester.md              # Testing agent
├── reviewer.md            # Review agent
└── custom-agent.md        # Project-specific agent
```

**Convention**: One file per agent, named `{agent-name}.md`

## Parsing Implementation

```typescript
import { parse as parseYaml } from "npm:yaml";
import { extract } from "std/front_matter/yaml.ts";

/**
 * Load agent from markdown file.
 */
async function loadAgent(path: string): Promise<Agent> {
  const content = await Deno.readTextFile(path);

  // Extract YAML frontmatter and markdown body
  const { attrs, body } = extract(content);

  // Parse frontmatter
  const frontmatter = parseYaml(attrs) as AgentFrontmatter;

  // Validate frontmatter
  validateFrontmatter(frontmatter);

  // Extract system prompt from markdown
  const systemPrompt = extractSystemPrompt(body);

  return {
    name: frontmatter.name,
    displayName: frontmatter.displayName,
    whenToUse: frontmatter.whenToUse,
    systemPrompt,
    tools: frontmatter.tools,
    transitions: frontmatter.transitions,
    limits: frontmatter.limits,
    provider: frontmatter.provider,
    metadata: frontmatter.metadata,
  };
}

/**
 * Extract system prompt from markdown body.
 * Looks for ## System Prompt section.
 */
function extractSystemPrompt(body: string): string {
  // Find "## System Prompt" section
  const match = body.match(
    /## System Prompt\n\n([\s\S]*?)(?=\n## |\n---|\z)/i
  );

  if (match) {
    return match[1].trim();
  }

  // Fallback: use entire body if no section found
  return body.trim();
}

/**
 * Validate frontmatter against schema.
 */
function validateFrontmatter(fm: unknown): void {
  if (!fm || typeof fm !== "object") {
    throw new Error("Frontmatter must be an object");
  }

  const f = fm as Record<string, unknown>;

  if (!f.name || typeof f.name !== "string") {
    throw new Error("Frontmatter must have name field");
  }

  if (!f.displayName || typeof f.displayName !== "string") {
    throw new Error("Frontmatter must have displayName field");
  }

  if (!f.transitions || typeof f.transitions !== "object") {
    throw new Error("Frontmatter must have transitions field");
  }

  const trans = f.transitions as Record<string, unknown>;
  if (!trans.onSuccess || typeof trans.onSuccess !== "string") {
    throw new Error("transitions.onSuccess is required");
  }
}

/**
 * Load all agents from .rawko/agents/
 */
async function loadAllAgents(): Promise<Map<string, Agent>> {
  const agents = new Map<string, Agent>();

  try {
    for await (const entry of Deno.readDir(".rawko/agents")) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      try {
        const path = `.rawko/agents/${entry.name}`;
        const agent = await loadAgent(path);
        agents.set(agent.name, agent);
      } catch (error) {
        console.error(`Failed to load ${entry.name}:`, error.message);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.warn(".rawko/agents directory not found");
    } else {
      throw error;
    }
  }

  return agents;
}
```

## Common Agent Configurations

### Minimal Agent

```markdown
---
name: simple-agent
displayName: Simple Agent
whenToUse: "Description of when to use"
transitions:
  onSuccess: next-agent
---

# Simple Agent

## System Prompt

Your system prompt here.
```

### Full-Featured Agent

```markdown
---
name: full-agent
displayName: Full Agent
whenToUse: |
  Multi-line description
  of when to use
tools:
  allowed: [Read, Write]
  blocked: [Delete]
  bashFilter:
    allowedCommands: [ls, find]
    blockedPatterns: ["rm -"]
transitions:
  onSuccess: next-agent
  onFailure: retry-agent
  onMaxIterations: escalate-agent
limits:
  maxIterations: 10
  timeout: 60000
  maxTokens: 4096
provider:
  name: claude
  model: claude-sonnet-4
metadata:
  category: implementation
  priority: 1
  tags: [code, production]
---

# Full Agent

## System Prompt

Detailed system prompt...

## Responsibilities

1. Item 1
2. Item 2

## Constraints

- Constraint 1
- Constraint 2
```

## Advantages vs. YAML-Only

| Aspect | YAML | Markdown + Frontmatter |
|--------|------|------------------------|
| Frontmatter readability | Good | Excellent |
| System prompt formatting | Difficult (multiline strings) | Easy (markdown) |
| Code examples | Escaped, hard to read | Native code blocks |
| IDE support | Basic | Excellent |
| Version control diffs | Hard to read | Clean diffs |
| Inline comments | Limited | Full markdown comments |
| Editing experience | Text editor | Any markdown editor |

## Migration from YAML

Convert existing YAML agents to markdown:

```typescript
async function migrateYamlAgent(yamlPath: string): Promise<string> {
  const yaml = await Deno.readTextFile(yamlPath);
  const config = parseYaml(yaml) as any;

  // Build markdown
  let md = "---\n";
  md += `name: ${config.name}\n`;
  md += `displayName: ${config.displayName}\n`;
  md += `whenToUse: ${JSON.stringify(config.whenToUse)}\n`;

  if (config.tools) {
    md += `tools:\n${indent(stringifyYaml(config.tools), 2)}`;
  }

  md += `transitions:\n${indent(stringifyYaml(config.transitions), 2)}`;

  if (config.limits) {
    md += `limits:\n${indent(stringifyYaml(config.limits), 2)}`;
  }

  md += "---\n\n";
  md += `# ${config.displayName}\n\n`;
  md += `## System Prompt\n\n`;
  md += config.systemPrompt;

  return md;
}
```

## Validation

Agent files should:
1. Have valid YAML frontmatter
2. Have required frontmatter fields
3. Have valid markdown body
4. Reference only existing transition targets

```bash
# Validate all agents
deno run --allow-read scripts/validate-agents.ts
```

## Best Practices

1. **Keep prompts focused** - One responsibility per agent
2. **Be explicit** - State what agent should and shouldn't do
3. **Include examples** - Show code patterns in system prompt
4. **Use consistent transitions** - Clear flow between agents
5. **Test locally** - Run agents and verify behavior
6. **Version control** - Track changes with git
7. **Document changes** - Explain why you modified agent

## Integration with Machine

Agents are loaded when machine starts:

```typescript
// In CLI startup:
const agents = await loadAllAgents();

// Validate agent set:
validateAgentSet(agents);

// Pass to machine:
const actor = createActor(rawkoMachine, {
  input: { agents },
});
```

When selecting an agent, the frontmatter's `whenToUse` is used by arbiter to decide.

When executing, the extracted `systemPrompt` is injected into LLM requests.
