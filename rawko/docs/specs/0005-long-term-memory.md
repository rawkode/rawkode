# SPEC-0005: Long-Term Memory and Extraction

## Abstract

This specification defines how rawko-sdk extracts and stores long-term memories from agent execution, enabling agents to learn from prior runs without session state persistence or context rot.

## Motivation

Independent task runs require knowledge accumulation:
- Avoid re-discovering codebase structure
- Remember failure patterns
- Build knowledge base from experience
- Enable arbiter to make informed decisions
- Never restore state, only inject background knowledge

## Detailed Design

### Memory Model

```
Every task run is independent (no context rot)
         ↓
    Agent executes
         ↓
 Memory Extraction Agent
    Evaluates output:
    "Is this worth remembering?"
         ↓
 If yes: Append to ./memories/*.md
    (append-only, never delete)
         ↓
 Future runs:
    Read ./memories/*.md frontmatter
    Inject relevant memories as background knowledge
    Execute independently
```

### Memory File Format

Markdown with YAML frontmatter. Files are append-only.

```markdown
---
title: "Authentication Module Structure"
whenToUse:
  - pattern: "auth|authentication|login|security"
  - pattern: "implement.*auth"
tags: [auth, codebase-structure, important]
importance: high
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
discoveredIn: "Task: Implement user authentication"
---

# Authentication Module Structure

Location: `src/auth/` directory contains:

## Files

- `src/auth/middleware.ts` - Token validation middleware
- `src/auth/types.ts` - Type definitions
- `src/auth/providers.ts` - Auth provider implementations

## Key Patterns

1. **JWT-based authentication**
   - Uses `jsonwebtoken` library
   - Tokens expire after 24 hours
   - Bearer token format: `Authorization: Bearer <token>`

2. **Password security**
   - Bcrypt hashing with salt rounds: 10
   - Passwords never stored in plain text
   - Located in src/auth/middleware.ts

3. **Middleware pattern**
   - Express middleware function signature
   - Attaches user to `req.user`
   - Returns 401 on auth failure

## Important Constraints

- No OAuth2 integration (not in scope)
- Session store integration still needed
- New auth work must follow existing JWT pattern

## Related Files

- src/api/middleware.ts (existing middleware patterns)
- src/models/User.ts (user schema)
```

### Frontmatter Schema

```typescript
interface MemoryFrontmatter {
  /** Unique, descriptive title */
  title: string;

  /** When this memory should be injected */
  whenToUse: string[] | string;
  // Can be:
  // - Array of regex patterns: ["auth|login", "implement.*auth"]
  // - Description: "When task mentions authentication"
  // - Both: ["auth|login", "When implementing security features"]

  /** Categorical tags for organization */
  tags: string[];

  /** How important is this memory */
  importance: "low" | "medium" | "high" | "critical";

  /** When was this discovered */
  discoveredAt: string; // ISO 8601 timestamp

  /** Which agent discovered this */
  discoveredBy: string; // agent name

  /** Which task led to this discovery */
  discoveredIn?: string;

  /** Optional custom fields */
  [key: string]: unknown;
}
```

### Memory File Organization

```
./memories/
├── codebase-structure/
│   ├── project-layout.md
│   ├── auth-module-structure.md
│   ├── database-schema.md
│   └── dependency-graph.md
├── code-patterns/
│   ├── middleware-pattern.md
│   ├── error-handling.md
│   └── testing-conventions.md
├── failures/
│   ├── oauth-integration-too-broad.md
│   ├── npm-install-failures.md
│   └── circular-dependency.md
└── solutions/
    ├── password-hashing-approach.md
    └── session-management-strategy.md
```

### Memory Extraction Process

The Memory Extraction Agent runs after each agent completes.

```typescript
interface MemoryExtractionInput {
  /** Which agent just executed */
  agent: string;

  /** The agent's task/prompt */
  task: string;

  /** The agent's output/response */
  agentOutput: string;

  /** Execution result */
  result: "success" | "failure" | "partial";

  /** Any error if failed */
  error?: string;

  /** Current memories for context */
  existingMemories: MemoryFile[];
}

interface MemoryExtractionOutput {
  /** Should we write a new memory? */
  shouldCreateMemory: boolean;

  /** Title for new memory (if creating) */
  memoryTitle?: string;

  /** Frontmatter for new memory */
  frontmatter?: MemoryFrontmatter;

  /** Content for new memory */
  content?: string;

  /** Reasoning for decision */
  reasoning: string;
}
```

**Extraction Algorithm**:

```typescript
const EXTRACTION_PROMPT = `
You are extracting long-term memories from an agent's execution.

AGENT OUTPUT:
{agentOutput}

TASK:
{task}

RESULT:
{result}

EXISTING MEMORIES:
{existingMemories}

Evaluate: Is there something in this output worth remembering long-term?

Examples of worth remembering:
- Discovered codebase structure or locations
- Found code patterns or conventions
- Identified dependencies or versions
- Learned about constraints or limitations
- Identified what doesn't work (negative learning)
- Found architectural decisions or trade-offs

Examples NOT worth remembering:
- Intermediate debugging steps
- Temporary files or commands
- Verbose explanations already in code
- Things obvious from reading the code

If YES, provide:
{
  "shouldCreateMemory": true,
  "memoryTitle": "Clear, specific title",
  "frontmatter": {
    "title": "...",
    "whenToUse": ["pattern1|pattern2", "description"],
    "tags": ["tag1", "tag2"],
    "importance": "high",
    "discoveredBy": "{agent}"
  },
  "content": "Markdown content with key learnings"
}

If NO, provide:
{
  "shouldCreateMemory": false,
  "reasoning": "Why this doesn't need to be remembered"
}
`;

async function extractMemory(input: MemoryExtractionInput): Promise<MemoryExtractionOutput> {
  const prompt = EXTRACTION_PROMPT
    .replace("{agentOutput}", input.agentOutput)
    .replace("{task}", input.task)
    .replace("{result}", input.result)
    .replace("{existingMemories}", formatExistingMemories(input.existingMemories))
    .replace("{agent}", input.agent);

  // Call LLM (can use different model, e.g., claude-haiku for cost)
  const response = await arbiter.session.sendMessage({
    role: "user",
    content: prompt,
  });

  return parseMemoryExtraction(response);
}
```

### Writing Memories

After extraction, append to memory file:

```typescript
async function appendMemory(
  memory: MemoryExtractionOutput
): Promise<void> {
  if (!memory.shouldCreateMemory) {
    return;
  }

  // Determine file path from title
  const filename = slugify(memory.memoryTitle); // e.g., "auth-module-structure"
  const filepath = `.rawko/memories/${filename}.md`;

  // Format with frontmatter
  const content = formatMemoryFile(memory);

  // APPEND (never overwrite)
  const existing = await tryReadFile(filepath);
  const updated = existing ? existing + "\n\n" + content : content;

  await Deno.writeTextFile(filepath, updated);
}

function formatMemoryFile(memory: MemoryExtractionOutput): string {
  const frontmatter = YAML.stringify(memory.frontmatter);
  return `---\n${frontmatter}---\n\n${memory.content}`;
}
```

### Memory Reading for Injection

Arbiter reads memory files to inject relevant context:

```typescript
interface MemoryFile {
  path: string;
  filename: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

async function loadAllMemories(): Promise<MemoryFile[]> {
  const memories: MemoryFile[] = [];

  try {
    for await (const entry of Deno.readDir(".rawko/memories")) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      const path = `.rawko/memories/${entry.name}`;
      const content = await Deno.readTextFile(path);
      const { attrs, body } = extractFrontmatter(content);

      memories.push({
        path,
        filename: entry.name,
        frontmatter: attrs as MemoryFrontmatter,
        content: body,
      });
    }
  } catch (error) {
    // memories directory doesn't exist yet, that's fine
  }

  return memories;
}

/**
 * Find memories relevant to a task/agent context.
 */
function findRelevantMemories(
  memories: MemoryFile[],
  context: {
    task: string;
    agentName: string;
    recentHistory?: string;
  }
): MemoryFile[] {
  const relevant: MemoryFile[] = [];

  for (const memory of memories) {
    const { whenToUse } = memory.frontmatter;

    // Check if whenToUse patterns match
    const matched = matchWhenToUse(whenToUse, context);

    if (matched) {
      relevant.push(memory);
    }
  }

  // Sort by importance
  return relevant.sort((a, b) => {
    const importanceOrder = { critical: 3, high: 2, medium: 1, low: 0 };
    return (
      importanceOrder[b.frontmatter.importance] -
      importanceOrder[a.frontmatter.importance]
    );
  });
}

/**
 * Match whenToUse patterns against context.
 */
function matchWhenToUse(
  whenToUse: string | string[],
  context: {
    task: string;
    agentName: string;
  }
): boolean {
  const patterns = Array.isArray(whenToUse) ? whenToUse : [whenToUse];

  const text = `${context.task} ${context.agentName}`.toLowerCase();

  for (const pattern of patterns) {
    // Check if it's a regex pattern (contains |, or regex chars)
    if (pattern.includes("|") || pattern.includes("*")) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(text)) {
          return true;
        }
      } catch {
        // Invalid regex, skip
      }
    } else {
      // Simple substring match
      if (text.includes(pattern.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}
```

## Examples

### Example 1: Codebase Structure Memory

```markdown
---
title: "Project File Structure"
whenToUse:
  - "exploring the codebase"
  - "find.*file|locate.*module"
tags: [structure, codebase, important]
importance: critical
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
discoveredIn: "Task: Implement user authentication"
---

# Project File Structure

## Root Layout

```
├── src/
│   ├── api/          # HTTP endpoints
│   ├── auth/         # Authentication
│   ├── models/       # Data types and schemas
│   ├── services/     # Business logic
│   └── middleware/   # Express middleware
├── tests/            # Test files
├── package.json
└── tsconfig.json
```

## Key Locations

- **API routes**: src/api/routes/
- **Database models**: src/models/
- **Authentication**: src/auth/ (JWT-based)
- **Middleware**: src/middleware/express-middleware.ts
```

### Example 2: Failure Pattern Memory

```markdown
---
title: "OAuth2 Integration Too Broad for MVP"
whenToUse:
  - "oauth|social.*auth|third.*party.*auth"
  - "scope.*too.*large"
tags: [auth, failures, scope]
importance: high
discoveredAt: 2026-01-23T10:35:00Z
discoveredBy: developer
discoveredIn: "Task: Implement user authentication"
---

# Why OAuth2 Was Not Used

## Attempted Approach

Considered implementing OAuth2 for social authentication (Google, GitHub, etc.)

## Why It Failed

1. **Scope mismatch**: Task requires JWT-based auth only
2. **Complexity**: OAuth2 adds significant infrastructure
3. **Requirements misalignment**: No mention of social providers in task
4. **Timeline**: Would require dependency setup and testing

## Decision

Stick with JWT-based authentication. OAuth2 can be added later if needed.

## Lesson

Always read task requirements carefully before selecting approach.
```

### Example 3: Code Pattern Memory

```markdown
---
title: "Express Middleware Pattern"
whenToUse:
  - "middleware|interceptor"
  - "follow.*existing.*pattern"
tags: [patterns, conventions, middleware]
importance: high
discoveredAt: 2026-01-23T10:40:00Z
discoveredBy: developer
---

# Express Middleware Pattern Used in Project

## Signature

All middleware follows this pattern:

```typescript
export function middlewareName(req, res, next) {
  try {
    // Check condition
    if (!valid(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    // Pass data to request
    req.user = extractUser(req);
    
    // Continue
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
```

## Key Points

1. Error handling with try/catch
2. Return 401 for auth failure
3. Use `req.user` for user data
4. Always call `next()` on success
5. Always return response on failure

## Where Used

- src/middleware/express-middleware.ts
- src/auth/middleware.ts
```

## Integration with Machine

```typescript
// In XState machine, before sending message to agent:

async function buildAgentPrompt(
  agent: AgentConfig,
  task: string,
  context: RawkoContext
): Promise<string> {
  const basePrompt = agent.systemPrompt;

  // Load relevant memories
  const allMemories = await loadAllMemories();
  const relevantMemories = findRelevantMemories(allMemories, {
    task,
    agentName: agent.name,
  });

  // Format memories for injection
  const memoryContext = formatMemoriesForPrompt(relevantMemories);

  return `${basePrompt}

${memoryContext}

## Task

${task}`;
}

function formatMemoriesForPrompt(memories: MemoryFile[]): string {
  if (memories.length === 0) {
    return "";
  }

  let context = "## Background Knowledge from Previous Runs\n\n";

  for (const memory of memories) {
    context += `### ${memory.frontmatter.title}\n`;
    context += `*Discovered by: ${memory.frontmatter.discoveredBy}*\n\n`;
    context += memory.content;
    context += "\n\n";
  }

  return context;
}
```

## Append-Only Semantics

Memory files grow forever, never shrink:

```typescript
/**
 * Memory files are append-only.
 * Never delete, never overwrite.
 * Only add new insights.
 */
async function appendMemory(memory: MemoryExtractionOutput): Promise<void> {
  const filepath = `.rawko/memories/${slugify(memory.memoryTitle)}.md`;

  // Read existing (if any)
  let content = "";
  try {
    content = await Deno.readTextFile(filepath);
  } catch {
    // File doesn't exist yet
  }

  // APPEND new memory
  if (content) {
    content += "\n\n---\n\n"; // Separator between memories
  }

  content += formatMemoryFile(memory);

  // Write back (append)
  await Deno.writeTextFile(filepath, content);
}
```

## Cleanup and Maintenance

Memory files can be manually reviewed and consolidated:

```typescript
/**
 * Manual: Review and consolidate old memories.
 * This is a human operation, not automatic.
 */
async function consolidateMemories(): Promise<void> {
  // List all memories
  const memories = await loadAllMemories();

  // Human reviews:
  // - Are there duplicates?
  // - Are there contradictions?
  // - Can we consolidate related memories?

  // Human decides:
  // - Keep both? Merge? Delete one?
  // - Update importance or whenToUse?

  // Then edits files manually
}
```

## Memory Extraction Agent Configuration

The Memory Extraction Agent is itself an agent (can be configured):

```yaml
# .rawko/agents/memory-extractor.md
---
name: memory-extractor
displayName: Memory Extraction Agent
whenToUse: |
  Internal agent, runs after every agent completes.
  Extracts long-term memories from execution output.
tools:
  allowed: [Read]
  blocked: [Write, Edit, Bash]
limits:
  maxIterations: 1
  timeout: 30000
  maxTokens: 2048
---

# Memory Extraction Agent

You are extracting valuable long-term memories from an agent's work.

Your task is to identify what's worth remembering...
```

## Drawbacks

1. **LLM overhead** - Memory extraction costs tokens per execution
2. **Hallucination risk** - LLM might extract invalid "memories"
3. **Manual curation** - Memories might need human review/consolidation
4. **Selective forgetting** - Can't automatically remove outdated memories
5. **Pattern complexity** - `whenToUse` pattern matching has edge cases

## Unresolved Questions

1. **Frequency** - Extract memory after every agent? Every N iterations?
2. **Sampling** - For long executions, sample outputs to extract from?
3. **Versioning** - How to handle memory about past code that's no longer valid?
4. **Consolidation** - Automated memory cleanup/consolidation?
5. **Conflicts** - How to handle contradictory memories from different runs?
6. **Selective injection** - Limit memories to top N most relevant?
