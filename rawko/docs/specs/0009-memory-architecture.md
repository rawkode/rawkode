# SPEC-0009: Unified Memory Architecture

## Abstract

This specification unifies the rawko-sdk memory system, consolidating session-scoped memory, long-term memory extraction, and memory injection into a single reference document.

## Related Documents

This spec supersedes and consolidates:
- `specs/0005-long-term-memory.md` - Extraction and storage
- `specs/0007-arbiter-memory-injection.md` - Injection into prompts
- `conventions/MEMORY-FILES.md` - Session-scoped YAML format
- `conventions/MEMORY-FILES-MARKDOWN.md` - Long-term Markdown format

## Memory System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         rawko-sdk Memory System                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐                      ┌─────────────────────────┐   │
│  │   Task Run      │                      │   Long-Term Memory      │   │
│  │   (ephemeral)   │                      │   .rawko/memories/*.md  │   │
│  └────────┬────────┘                      └───────────▲─────────────┘   │
│           │                                           │                  │
│           │ executes                                  │ append-only      │
│           ▼                                           │                  │
│  ┌─────────────────┐      extracts      ┌─────────────┴─────────────┐   │
│  │     Agent       │─────────────────────│  Memory Extraction Agent │   │
│  │    Execution    │                     │  "Is this worth          │   │
│  └────────┬────────┘                     │   remembering?"          │   │
│           │                              └───────────────────────────┘   │
│           │ completes                                                    │
│           ▼                                                              │
│  ┌─────────────────┐                                                    │
│  │  Next Agent     │◄────── injects ────────────────────────────────────│
│  │    Receives     │        relevant                                    │
│  │    Memories     │        memories     ┌─────────────────────────┐   │
│  └─────────────────┘                     │     Arbiter             │   │
│                                          │  "Which memories are    │   │
│                                          │   relevant?"            │   │
│                                          └─────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Principles

1. **No Session State** - Each task run is independent (no context rot)
2. **Append-Only** - Memories are never deleted, only added
3. **Selective Injection** - Only relevant memories are injected into prompts
4. **Background Knowledge** - Memories provide context, not state restoration

## Memory File Format

### Location

```
.rawko/memories/
├── project-structure.md           # Codebase layout
├── auth-module-structure.md       # Auth module specifics
├── jwt-implementation-pattern.md  # JWT patterns used
├── oauth-too-broad.md             # Failure case
├── middleware-pattern.md          # Express middleware style
└── database-schema.md             # Schema structure
```

### File Structure

Markdown with YAML frontmatter:

```markdown
---
title: "Authentication Module Structure"
whenToUse:
  - "auth|authentication|login|security"
  - "When implementing security features"
tags: [auth, codebase-structure, important]
importance: high
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
discoveredIn: "Task: Implement user authentication"
---

# Authentication Module Structure

One-sentence summary.

## Overview

Brief description...

## Key Points

- Point 1
- Point 2

## Code Example

```typescript
// Example pattern...
```
```

### Frontmatter Schema

```typescript
interface MemoryFrontmatter {
  /** Unique, descriptive title */
  title: string;

  /** When this memory should be injected */
  whenToUse: string | string[];
  // Supports:
  // - Regex patterns: "auth|login|security"
  // - Natural language: "When task mentions authentication"
  // - Arrays (OR logic): ["auth|login", "implementing security"]

  /** Categorical tags */
  tags: string[];

  /** How important: low | medium | high | critical */
  importance: "low" | "medium" | "high" | "critical";

  /** When discovered (ISO 8601) */
  discoveredAt: string;

  /** Which agent discovered this */
  discoveredBy: string;

  /** Optional: Which task led to discovery */
  discoveredIn?: string;

  /** Optional: Source of discovery */
  source?: string;

  /** Optional: Related memory filenames */
  relatedMemories?: string[];
}
```

### Content Guidelines

| Aspect | Guideline |
|--------|-----------|
| Length | 200-500 words ideal, max 2000 |
| Structure | Clear headings, code examples |
| Naming | `kebab-case-descriptive-name.md` |
| Updates | Append with `---` separator, never overwrite |

## Memory Extraction

### Flow

```
Agent completes execution
         ↓
Memory Extraction Agent evaluates:
  "Is this worth remembering long-term?"
         ↓
     ┌───┴───┐
     │       │
    YES      NO
     │       │
     ▼       ▼
  Write    Discard
  memory
```

### What to Extract

**YES - Extract**:
- Codebase structure discovered
- Code patterns or conventions
- Key constraints or limitations
- Errors and their causes
- Architectural decisions
- Dependencies or versions

**NO - Skip**:
- Temporary debugging steps
- Command output or logs
- Trivial findings
- Duplicates of existing memories

### Extraction Implementation

```typescript
interface MemoryExtractionInput {
  agent: string;
  task: string;
  agentOutput: string;
  result: "success" | "failure" | "partial";
  error?: string;
  existingMemories: MemoryFile[];
}

interface MemoryExtractionOutput {
  shouldCreateMemory: boolean;
  memoryTitle?: string;
  frontmatter?: MemoryFrontmatter;
  content?: string;
  reasoning: string;
}

async function extractMemory(
  input: MemoryExtractionInput
): Promise<MemoryExtractionOutput> {
  const prompt = buildExtractionPrompt(input);
  const response = await llm.complete(prompt);
  return parseExtractionResponse(response);
}
```

### Writing Memories

```typescript
async function appendMemory(memory: MemoryExtractionOutput): Promise<void> {
  if (!memory.shouldCreateMemory) return;

  const filename = slugify(memory.memoryTitle);
  const filepath = `.rawko/memories/${filename}.md`;

  // Format with frontmatter
  const formatted = formatMemoryFile(memory);

  // APPEND (never overwrite)
  const existing = await tryReadFile(filepath);
  const content = existing
    ? existing + "\n\n---\n\n" + formatted
    : formatted;

  await Deno.writeTextFile(filepath, content);
}
```

## Memory Injection

### Flow

```
Agent is about to execute
         ↓
Load all memory frontmatter
         ↓
Score and match memories against:
  - Task description
  - Agent type
  - whenToUse patterns
         ↓
Select top N most relevant
         ↓
Format for prompt injection
         ↓
Agent executes with background knowledge
```

### Relevance Matching

```typescript
interface MatchContext {
  task: string;
  agentName: string;
  currentPlan?: string;
}

function findRelevantMemories(
  memories: MemoryMetadata[],
  context: MatchContext,
  options: { maxMemories?: number; minImportance?: string } = {}
): MemoryMetadata[] {
  const maxMemories = options.maxMemories ?? 5;

  return memories
    .filter(m => matchWhenToUse(m.frontmatter.whenToUse, context))
    .map(m => ({ memory: m, score: scoreRelevance(m, context) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMemories)
    .map(item => item.memory);
}
```

### Scoring Algorithm

| Factor | Points | Description |
|--------|--------|-------------|
| Importance: critical | 30 | Always include if relevant |
| Importance: high | 25 | Include for close matches |
| Importance: medium | 15 | Include for moderate matches |
| Importance: low | 5 | Include for exact matches only |
| Recency < 24h | 10 | Recent discoveries prioritized |
| Recency < 72h | 5 | Moderately recent |
| Keyword match | 0-20 | Task words in memory title |
| Agent specialty | 0-15 | Tags match agent type |
| Same discoverer | 10 | Agent discovered this before |

### Prompt Formatting

```typescript
function formatMemoriesForPrompt(memories: MemoryFile[]): string {
  if (memories.length === 0) return "";

  let formatted = "## Background Knowledge from Previous Runs\n\n";

  for (const memory of memories) {
    formatted += `### ${memory.frontmatter.title}\n`;
    formatted += `*Importance: ${memory.frontmatter.importance.toUpperCase()}*\n`;
    formatted += `*Discovered by: ${memory.frontmatter.discoveredBy}*\n\n`;
    formatted += truncate(memory.content, 500) + "\n\n";
  }

  return formatted;
}
```

## Pattern Matching

The `whenToUse` field supports multiple pattern formats:

### Pattern Types

```typescript
function matchPattern(pattern: string, text: string): boolean {
  const normalized = pattern.toLowerCase().trim();

  // 1. Pipe-separated alternatives: "auth|login|security"
  if (normalized.includes("|")) {
    return normalized.split("|").some(alt => text.includes(alt.trim()));
  }

  // 2. Wildcard patterns: "implement.*auth"
  if (normalized.includes("*")) {
    const regex = new RegExp(normalized.replace(/\*/g, ".*"), "i");
    return regex.test(text);
  }

  // 3. Simple substring
  return text.includes(normalized);
}
```

### Examples

| Pattern | Matches | Doesn't Match |
|---------|---------|---------------|
| `auth\|login\|security` | "add login page" | "add user page" |
| `implement.*auth` | "implement authentication" | "auth module" |
| `When implementing security` | "security features task" | "database task" |

## Integration Points

### XState Machine Integration

```typescript
executing: {
  invoke: {
    id: "executeAgent",
    src: "agentExecutor",
    input: async ({ context }) => {
      // Build prompt with injected memories
      const systemPrompt = await buildAgentPrompt(
        context.currentAgent,
        {
          task: context.task,
          currentPlan: context.plan,
        }
      );

      return {
        agent: context.currentAgent,
        systemPrompt,
        task: context.task,
      };
    },
    onDone: {
      actions: [
        // After execution, extract memories
        ({ context }) => extractAndSaveMemory(context),
      ],
    },
  },
}
```

### Agent Configuration

Agents can customize memory behavior:

```yaml
name: developer
memory:
  maxInjected: 5           # Max memories to include
  minImportance: "medium"  # Minimum importance threshold
```

## Examples

### Example 1: Codebase Structure Memory

```markdown
---
title: "Project File Organization"
whenToUse:
  - "exploring|navigate|find.*file"
  - "When understanding project structure"
tags: [structure, codebase, important]
importance: critical
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
---

# Project File Organization

## Directory Layout

```
├── src/
│   ├── api/          # HTTP endpoints
│   ├── auth/         # Authentication (JWT-based)
│   ├── models/       # Data types
│   └── services/     # Business logic
├── tests/
└── package.json
```

## Key Locations

- **API routes**: src/api/routes/
- **Authentication**: src/auth/
- **Database models**: src/models/
```

### Example 2: Failure Memory

```markdown
---
title: "OAuth2 Integration Was Too Broad"
whenToUse: ["oauth|social.*auth", "considering auth approaches"]
tags: [failures, auth, scope]
importance: high
discoveredAt: 2026-01-23T10:45:00Z
discoveredBy: developer
---

# Why OAuth2 Was Rejected

## What Was Attempted

Considered OAuth2 social login (Google, GitHub).

## Why It Failed

1. Task explicitly requires JWT only
2. OAuth2 adds significant complexity
3. Not mentioned in requirements

## Decision

Stick with JWT-based authentication.
```

### Example 3: Code Pattern Memory

```markdown
---
title: "Express Middleware Pattern"
whenToUse: ["middleware|interceptor", "writing Express handlers"]
tags: [patterns, conventions, express]
importance: high
discoveredAt: 2026-01-23T10:40:00Z
discoveredBy: developer
---

# Express Middleware Pattern

All middleware follows this pattern:

```typescript
export function middlewareName(req, res, next) {
  try {
    if (!valid(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = extractUser(req);
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
```

## Key Points

1. Always wrap in try/catch
2. Return 401 on auth failure
3. Pass user via `req.user`
4. Always call `next()` on success
```

## Drawbacks

1. **LLM overhead** - Memory extraction costs tokens per execution
2. **Hallucination risk** - LLM might extract invalid memories
3. **Pattern complexity** - Multiple pattern formats can confuse
4. **Stale memories** - Old memories may describe outdated code
5. **Memory pollution** - Too many memories can clutter prompts

## Unresolved Questions

1. How often should extraction run? Every agent? Every N iterations?
2. How to handle contradictory memories from different runs?
3. Should we auto-deprecate old memories?
4. How to learn which memories are actually useful (feedback loop)?
5. What's the token budget for memory injection?

## Migration

To consolidate existing memory documentation:

1. This spec becomes the authoritative reference
2. Keep `conventions/MEMORY-FILES.md` and `conventions/MEMORY-FILES-MARKDOWN.md` as quick-reference guides that link here
3. `specs/0005-long-term-memory.md` and `specs/0007-arbiter-memory-injection.md` remain for historical context but link to this spec
