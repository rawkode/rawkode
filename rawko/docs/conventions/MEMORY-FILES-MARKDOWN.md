# Convention: Memory Files (Markdown + YAML Frontmatter)

## Overview

Memory files store long-term learnings from task execution. They are **append-only** Markdown files with YAML frontmatter that enable knowledge accumulation across independent task runs.

**Format**: Markdown with YAML frontmatter  
**Location**: `.rawko/memories/` (one file per distinct memory)  
**Semantics**: Append-only (never delete, only add new memories)

## File Structure

```markdown
---
# YAML frontmatter
title: "Clear, specific title"
whenToUse: ["pattern1|pattern2", "natural language description"]
tags: [tag1, tag2]
importance: high
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: agent-name
discoveredIn: "Task description"
---

# Memory Title (optional, can differ from frontmatter title)

Markdown content describing the discovery or learning.

Can include:
- Multiple paragraphs
- Code blocks
- Lists and tables
- Links

## Section 1

Details...

## Section 2

More details...
```

## Frontmatter Fields

### Required Fields

**title** (string)
- Unique, descriptive title
- Examples: "Authentication Module Structure", "OAuth2 Too Broad for MVP"
- Used in formatting for agents

**whenToUse** (string or string[])
- When should this memory be injected?
- Can be:
  - **Regex patterns**: `["auth|login|security"]`
  - **Natural language**: `"When task mentions authentication"`
  - **Mixed**: `["auth|login", "When implementing security features"]`
- Arbiter uses these to decide injection
- Multiple patterns = OR logic (any match = include)

**importance** (low | medium | high | critical)
- How important is this knowledge?
- **critical**: Always inject if even slightly relevant
- **high**: Inject for closely matching tasks
- **medium**: Inject for moderately related tasks
- **low**: Only inject for exact matches
- Used for filtering and scoring

**discoveredAt** (ISO 8601 timestamp)
- When was this discovered? (e.g., "2026-01-23T10:30:00Z")
- Used for recency scoring
- Format: `2026-01-23T10:30:00Z`

**discoveredBy** (string)
- Which agent discovered this?
- Examples: "planner", "developer", "tester"
- Helps agents know if they've seen this before

### Optional Fields

**tags** (string[])
- Categorical tags for organization
- Examples: `["auth", "codebase-structure", "failure"]`
- Helps with discovery and filtering
- Common tags:
  - **codebase-structure**: Where things are located
  - **code-patterns**: How things are done
  - **api-surface**: Available functions/classes
  - **data-model**: Schemas and types
  - **failures**: What didn't work
  - **solutions**: What did work
  - **constraints**: Limitations

**discoveredIn** (string)
- Which task led to this discovery?
- Examples: "Task: Implement user authentication"
- Helps trace origin

**source** (string, optional)
- Source of the discovery
- Examples: "File: src/auth/middleware.ts", "Search: grep auth"

**relatedMemories** (string[], optional)
- IDs/filenames of related memories
- Examples: `["auth-module-structure", "jwt-patterns"]`

## Memory Naming

Memory files are named based on their content:

```
.rawko/memories/
├── project-structure.md           # Main codebase layout
├── auth-module-structure.md       # Auth module specifics
├── jwt-implementation-pattern.md  # JWT patterns used
├── oauth-too-broad.md             # Failure case
├── middleware-pattern.md          # Express middleware style
└── database-schema.md             # Schema structure
```

**Convention**: `kebab-case-descriptive-name.md`

## Content Guidelines

### Structure

Start with a clear heading matching the title:

```markdown
---
title: "Authentication Module Structure"
...
---

# Authentication Module Structure

One-sentence summary of what this memory covers.

## Overview

Brief description of the key information.

## Key Points

- Point 1
- Point 2
- Point 3

## Specific Details

More detailed information...

## Important Constraints

Limitations or gotchas...
```

### Length

- **Ideal**: 200-500 words
- **Minimum**: 50 words (at least something specific)
- **Maximum**: 2000 words (split into separate memories if longer)

### Code Examples

Include relevant code patterns:

```markdown
## Middleware Pattern

All middleware in this project follows:

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

Key points:
- Always try/catch
- Return on error
- Pass user to req.user
```

### File References

Link to specific files when relevant:

```markdown
## Location

The authentication module is located at:
- `src/auth/middleware.ts` - Token validation
- `src/auth/providers.ts` - Auth providers
- `src/auth/types.ts` - Type definitions

See: src/api/middleware.ts for similar patterns
```

## Memory Extraction Process

### When to Extract

Extract memory after each agent completes successfully:

```
Agent finishes
     ↓
Run Memory Extraction Agent
     ↓
Evaluate: "Worth remembering?"
     ↓
Yes: Write to ./memories/
No: Discard
```

### What's Worth Remembering?

**YES - Extract as memory**:
- New codebase structure discovered
- Code pattern or convention found
- Key constraint or limitation identified
- Error that occurred and its cause
- Architectural decision made
- Dependency or version discovered
- File location or relationship
- Configuration found

**NO - Skip extraction**:
- Temporary debugging steps
- Command output or logs
- Progress updates already shown
- Things obvious from reading code
- Duplicate of existing memory
- Very trivial findings

### Memory Extraction Agent

The Memory Extraction Agent evaluates each output:

```yaml
# In .rawko/agents/memory-extractor.md
---
name: memory-extractor
displayName: Memory Extraction Agent
whenToUse: Internal - runs after every agent execution
tools:
  allowed: [Read]
  blocked: [Write, Edit, Bash]
---

# Memory Extraction Agent

Evaluate agent output. Extract anything worth remembering long-term.
```

## Examples

### Example 1: Codebase Structure

```markdown
---
title: "Project File Organization"
whenToUse:
  - "exploring|navigate|find.*file|locate.*module"
  - "When needing to understand project structure"
tags: [structure, important, codebase]
importance: critical
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
discoveredIn: "Task: Implement user authentication"
---

# Project File Organization

The project follows this directory structure:

## Root Level

```
├── src/                 # All source code
├── tests/              # Test files
├── docs/               # Documentation
├── package.json        # Dependencies
└── tsconfig.json       # TypeScript config
```

## src/ Directory

```
src/
├── api/               # HTTP endpoints and routes
├── auth/              # Authentication logic (JWT-based)
├── models/            # Data schemas and types
├── services/          # Business logic
└── middleware/        # Express middleware
```

## Key Files

- `src/auth/middleware.ts` - Token validation middleware
- `src/models/User.ts` - User schema definition
- `src/api/routes/auth.ts` - Auth endpoints
```

### Example 2: Code Pattern

```markdown
---
title: "Error Handling Pattern in Express Handlers"
whenToUse: [error|exception|handle.*error, "Writing Express handlers"]
tags: [patterns, conventions, error-handling]
importance: high
discoveredAt: 2026-01-23T11:00:00Z
discoveredBy: developer
discoveredIn: "Task: Implement user authentication"
---

# Error Handling Pattern

The project consistently uses this pattern for error handling:

## Express Handler Pattern

```typescript
router.post("/endpoint", async (req, res) => {
  try {
    // Validation
    if (!req.body.required) {
      return res.status(400).json({ error: "Missing required field" });
    }

    // Processing
    const result = await service.process(req.body);

    // Success response
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error in endpoint:", error);
    res.status(500).json({ error: error.message });
  }
});
```

## Key Conventions

1. Always wrap in try/catch
2. Validate input first
3. Return early on validation failure
4. Log errors with context
5. Return consistent error format
6. Don't expose stack traces to client
```

### Example 3: Failure/Lesson

```markdown
---
title: "OAuth2 Integration Was Too Broad"
whenToUse:
  - "oauth|social.*auth|third.*party"
  - "When considering auth approaches"
tags: [failures, decisions, auth]
importance: high
discoveredAt: 2026-01-23T10:45:00Z
discoveredBy: developer
discoveredIn: "Task: Implement user authentication"
---

# Why OAuth2 Was Rejected

## What Was Attempted

Considered implementing OAuth2 social login (Google, GitHub providers).

## Why It Failed

1. **Task explicitly requires JWT** - Not mentioned in requirements
2. **Scope creep** - OAuth2 adds significant complexity
3. **Time cost** - Would delay MVP
4. **Not in requirements** - Task description didn't mention social auth
5. **Existing JWT works** - Project already uses JWT

## Decision Made

Stick with JWT-based authentication. OAuth2 can be added in future if needed.

## Key Lesson

Read requirements carefully before selecting approach. Don't implement nice-to-haves.
```

### Example 4: Constraint/Limitation

```markdown
---
title: "Session Store Integration Required"
whenToUse: [session|state.*management, "Working with authentication"]
tags: [constraints, auth, architecture]
importance: high
discoveredAt: 2026-01-23T10:50:00Z
discoveredBy: planner
discoveredIn: "Task: Implement user authentication"
---

# Session Management Architecture

## Current State

JWT tokens work for stateless auth, but session management still needed for:
- User logout (token revocation)
- Session timeout
- Multiple device management

## Implementation Requirement

Must choose/implement session store:

### Options Considered

1. **In-memory store** - Good for dev, bad for production
2. **Redis** - Fast, distributed, widely used
3. **Database** - Already have database, slower but persistent
4. **JWT revocation list** - Track revoked tokens

## Recommendation

Start with database-backed sessions until performance requires Redis upgrade.
```

## Update Patterns

### Adding to Existing Memory

When similar knowledge is discovered again, APPEND rather than replace:

```markdown
---
title: "Authentication Module Structure"
...
discoveredAt: 2026-01-23T10:30:00Z
discoveredBy: planner
---

# Authentication Module Structure

Original content...

---

## Update (2026-01-24)

Additional findings about the auth module:
- Also handles OAuth providers (see oauth-providers.ts)
- Database integration at models/UserSession.ts
```

### Correcting Mistakes

Mark corrections clearly:

```markdown
---
title: "Password Hashing Approach"
...
---

# Password Hashing Approach

## Original Finding

Uses bcrypt with 10 salt rounds.

## Correction (Found error in initial discovery)

Actually uses 12 salt rounds. Checked with:
```sh
grep "saltRounds" src/auth/middleware.ts  # Output: 12
```

## Updated Understanding

- Salt rounds: 12 (not 10)
- Algorithm: bcrypt
- No custom salt generation (bcrypt handles it)
```

## Best Practices

1. **Be specific**: Not "auth works", but "uses JWT with 24-hour expiry"
2. **Include examples**: Code snippets help agents understand patterns
3. **Name clearly**: File name should match title
4. **Tag well**: Use standard tags for consistency
5. **Date everything**: Include discoveredAt and source
6. **Link related**: Reference other memories
7. **Keep focused**: One memory per distinct concept
8. **Append thoughtfully**: Add updates, don't rewrite

## Validation

Memory files should be valid Markdown:

```bash
# Check YAML frontmatter
deno run --allow-read scripts/validate-memories.ts

# Check all memories
for file in .rawko/memories/*.md; do
  echo "Validating $file..."
  # validate YAML
done
```

## Integration Points

Memories are used:
1. **Agent prompts** - Injected as background knowledge
2. **Arbiter decisions** - Used for context-aware choices
3. **Human review** - Readable format for inspection
4. **Knowledge base** - Growing project documentation

## Evolution

Memory system improves over time:
- **Run 1**: Creates initial memories about codebase
- **Run 2**: Adds memories about common patterns
- **Run 3**: Adds memories about failures to avoid
- **Run 4+**: Builds comprehensive knowledge base

Eventually, agents benefit from rich contextual knowledge without consuming session state.
