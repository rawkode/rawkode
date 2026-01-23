# SPEC-0007: Arbiter Memory Injection

## Abstract

This specification defines how the arbiter reads long-term memories from `.rawko/memories/`, matches them against task context, and injects relevant memories into agent prompts.

## Motivation

Memories are only valuable if agents access them. The arbiter:
- Evaluates when memories are relevant
- Prevents irrelevant information from cluttering prompts
- Prioritizes high-importance memories
- Formats memories for clear agent comprehension

## Detailed Design

### Memory Injection Flow

```
Agent is about to execute
         ↓
Load all memory frontmatter from ./memories/
         ↓
Arbiter evaluates: "Which memories are relevant?"
    - Check whenToUse patterns
    - Match against task description
    - Match against agent type
         ↓
Select top N most relevant memories
         ↓
Format selected memories for prompt
         ↓
Inject into agent system prompt
         ↓
Agent executes with background knowledge
```

### Memory File Loading

```typescript
/**
 * Load all memory files from ./memories/
 * Read only frontmatter (for efficiency).
 */
async function loadMemoryFrontmatter(): Promise<MemoryMetadata[]> {
  const memories: MemoryMetadata[] = [];

  try {
    for await (const entry of Deno.readDir(".rawko/memories")) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      const path = `.rawko/memories/${entry.name}`;
      const content = await Deno.readTextFile(path);

      // Extract only frontmatter
      const { attrs } = extractFrontmatter(content);

      memories.push({
        path,
        filename: entry.name,
        frontmatter: attrs as MemoryFrontmatter,
      });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return []; // No memories yet
    }
    throw error;
  }

  return memories;
}

interface MemoryMetadata {
  path: string;
  filename: string;
  frontmatter: MemoryFrontmatter;
}
```

### Relevance Matching

```typescript
/**
 * Find memories relevant to an upcoming agent execution.
 */
function findRelevantMemories(
  memories: MemoryMetadata[],
  context: {
    task: string;
    agentName: string;
    agentDisplayName: string;
    currentPlan?: string;
    recentHistory?: string;
  },
  options: {
    maxMemories?: number; // Cap number of memories injected
    minImportance?: "low" | "medium" | "high" | "critical";
  } = {}
): MemoryMetadata[] {
  const maxMemories = options.maxMemories ?? 5;
  const minImportance = options.minImportance ?? "low";

  // Score each memory
  const scored = memories
    .map((memory) => ({
      memory,
      score: scoreMemoryRelevance(memory, context),
      matches: matchWhenToUse(memory.frontmatter.whenToUse, context),
    }))
    .filter((item) => item.matches) // Only include if matches
    .filter((item) => meetsImportanceThreshold(item.memory, minImportance))
    .sort((a, b) => b.score - a.score);

  // Return top N
  return scored.slice(0, maxMemories).map((item) => item.memory);
}

/**
 * Score memory relevance (0-100).
 */
function scoreMemoryRelevance(
  memory: MemoryMetadata,
  context: {
    task: string;
    agentName: string;
    currentPlan?: string;
    recentHistory?: string;
  }
): number {
  let score = 0;

  // Base importance score (0-30 points)
  const importanceMap = { low: 5, medium: 15, high: 25, critical: 30 };
  score += importanceMap[memory.frontmatter.importance] || 0;

  // Recency bonus (0-10 points)
  const ageHours =
    (Date.now() - new Date(memory.frontmatter.discoveredAt).getTime()) /
    3600000;
  if (ageHours < 24) score += 10;
  else if (ageHours < 72) score += 5;

  // Keyword match bonus (0-20 points)
  const taskWords = context.task.toLowerCase().split(/\s+/);
  const memoryTitle = memory.frontmatter.title.toLowerCase();
  const matchedWords = taskWords.filter((w) => memoryTitle.includes(w));
  score += Math.min(20, matchedWords.length * 5);

  // Agent specialty match (0-15 points)
  if (memory.frontmatter.tags) {
    // If memory is about "patterns" and agent is "developer", that's relevant
    const agentTags = getAgentTags(context.agentName);
    const commonTags = memory.frontmatter.tags.filter((t) =>
      agentTags.includes(t)
    );
    score += Math.min(15, commonTags.length * 5);
  }

  // Discovered by same agent (0-10 points)
  if (memory.frontmatter.discoveredBy === context.agentName) {
    score += 10; // "I discovered this before"
  }

  return Math.min(100, score);
}

/**
 * Check if memory matches whenToUse patterns.
 */
function matchWhenToUse(
  whenToUse: string | string[],
  context: {
    task: string;
    agentName: string;
  }
): boolean {
  const patterns = Array.isArray(whenToUse) ? whenToUse : [whenToUse];

  // Build searchable text from context
  const searchText = `${context.task} ${context.agentName}`.toLowerCase();

  for (const pattern of patterns) {
    // Pattern can be:
    // 1. Simple substring: "auth"
    // 2. Pipe-separated alternatives: "auth|login|security"
    // 3. Regex-like: "implement.*auth"
    // 4. Natural language: "When implementing authentication"

    if (matchPattern(pattern, searchText)) {
      return true;
    }
  }

  return false;
}

/**
 * Match a single pattern against text.
 */
function matchPattern(pattern: string, text: string): boolean {
  // Normalize pattern
  const normalized = pattern.toLowerCase().trim();

  // Try interpretations in order of likelihood

  // 1. Pipe-separated alternatives (e.g., "auth|login|security")
  if (normalized.includes("|")) {
    const alternatives = normalized.split("|").map((s) => s.trim());
    return alternatives.some((alt) => text.includes(alt));
  }

  // 2. Regex with wildcards (e.g., "implement.*auth")
  if (normalized.includes("*") || normalized.includes("?")) {
    try {
      // Convert glob pattern to regex
      const regex = new RegExp(
        normalized.replace(/\*/g, ".*").replace(/\?/g, "."),
        "i"
      );
      return regex.test(text);
    } catch {
      // Invalid regex, fall through
    }
  }

  // 3. Regex syntax (e.g., "implement.{0,5}auth")
  if (normalized.includes(".") && normalized.includes("{")) {
    try {
      const regex = new RegExp(normalized, "i");
      return regex.test(text);
    } catch {
      // Invalid regex, fall through
    }
  }

  // 4. Simple substring match
  return text.includes(normalized);
}

/**
 * Check importance threshold.
 */
function meetsImportanceThreshold(
  memory: MemoryMetadata,
  minImportance: string
): boolean {
  const order = { low: 0, medium: 1, high: 2, critical: 3 };
  return order[memory.frontmatter.importance] >= order[minImportance];
}

/**
 * Get tags associated with an agent type.
 */
function getAgentTags(agentName: string): string[] {
  const tagMap: Record<string, string[]> = {
    planner: ["planning", "structure", "analysis"],
    developer: ["implementation", "code", "patterns"],
    tester: ["testing", "validation", "quality"],
    reviewer: ["review", "quality", "standards"],
  };

  return tagMap[agentName] || [];
}
```

### Memory Content Loading

After selecting relevant memories, load their full content:

```typescript
/**
 * Load full content of selected memories.
 */
async function loadMemoryContent(
  memories: MemoryMetadata[]
): Promise<MemoryFile[]> {
  const full: MemoryFile[] = [];

  for (const memory of memories) {
    const content = await Deno.readTextFile(memory.path);
    const { body } = extractFrontmatter(content);

    full.push({
      ...memory,
      content: body,
    });
  }

  return full;
}

interface MemoryFile extends MemoryMetadata {
  content: string;
}
```

### Prompt Formatting

Format memories for injection into agent prompt:

```typescript
/**
 * Format memories for agent system prompt.
 */
function formatMemoriesForPrompt(memories: MemoryFile[]): string {
  if (memories.length === 0) {
    return "";
  }

  let formatted = "## Background Knowledge from Previous Runs\n\n";
  formatted +=
    "The following information was learned from prior runs and may be relevant:\n\n";

  for (const memory of memories) {
    formatted += `### ${memory.frontmatter.title}\n`;
    formatted += `*Importance: ${memory.frontmatter.importance.toUpperCase()}*\n`;
    formatted += `*Discovered by: ${memory.frontmatter.discoveredBy}*\n\n`;

    // Include content up to first-level heading or 500 chars
    let contentPreview = memory.content;
    const nextHeading = contentPreview.indexOf("\n# ");
    if (nextHeading > 0 && nextHeading < 500) {
      contentPreview = contentPreview.substring(0, nextHeading);
    } else if (contentPreview.length > 500) {
      contentPreview = contentPreview.substring(0, 500) + "...";
    }

    formatted += contentPreview + "\n\n";
  }

  return formatted;
}
```

### Integration with Agent Execution

```typescript
/**
 * Build agent system prompt with memory injection.
 */
async function buildAgentPrompt(
  agent: Agent,
  context: {
    task: string;
    currentPlan?: string;
    recentHistory?: string;
  }
): Promise<string> {
  // Start with agent's defined system prompt
  let prompt = agent.systemPrompt;

  // Load available memories
  const allMemories = await loadMemoryFrontmatter();

  // Find relevant memories
  const relevantMemories = findRelevantMemories(allMemories, {
    task: context.task,
    agentName: agent.name,
    agentDisplayName: agent.displayName,
    currentPlan: context.currentPlan,
    recentHistory: context.recentHistory,
  });

  // Load full content
  const memoryFiles = await loadMemoryContent(relevantMemories);

  // Format and add to prompt
  const memoryContext = formatMemoriesForPrompt(memoryFiles);

  if (memoryContext) {
    prompt += "\n\n" + memoryContext;
  }

  return prompt;
}
```

### XState Integration

Hook memory injection into machine:

```typescript
// In executing state:
executing: {
  invoke: {
    id: "executeAgent",
    src: "agentExecutor",
    input: async ({ context }) => {
      // Build prompt with memories
      const systemPrompt = await buildAgentPrompt(
        context.currentAgent,
        {
          task: context.task,
          currentPlan: context.plan
            ? JSON.stringify(context.plan)
            : undefined,
          recentHistory: context.history
            .slice(-3)
            .map((h) => `${h.agent}: ${h.output}`)
            .join("\n"),
        }
      );

      return {
        agent: context.currentAgent,
        systemPrompt,
        session: context.session,
        task: context.task,
      };
    },
    onDone: {
      // ... handle completion
    },
  },
}
```

## Examples

### Example 1: Task with Matching Memory

**Scenario**: Task is "Add OAuth integration to existing auth system"

**Available memories**:
1. "Project uses JWT authentication" (importance: high)
2. "OAuth2 integration was considered too broad" (importance: high, tags: [auth, failures])
3. "Express middleware pattern" (importance: high)
4. "Database schema version 2.1" (importance: medium)

**Agent**: developer

**Process**:
```
Task: "Add OAuth integration..."

Memory matching:
1. "OAuth2 integration too broad" - MATCH (task mentions OAuth)
   Score: high_importance(25) + keyword(15) = 40
   
2. "Project uses JWT auth" - MATCH (task mentions auth)
   Score: high_importance(25) + keyword(10) = 35
   
3. "Express middleware" - WEAK MATCH (patterns relevant to developer)
   Score: high_importance(25) + agent_tags(10) = 35
   
4. "Database schema" - NO MATCH
   Score: 0

Selected (top 3): OAuth failure, JWT auth, Middleware pattern
```

**Injected into prompt**:
```
## Background Knowledge from Previous Runs

### OAuth2 integration was considered too broad
*Importance: HIGH*
*Discovered by: developer*

Earlier attempts at OAuth2 failed because...

### Project uses JWT authentication
*Importance: HIGH*
*Discovered by: planner*

The project currently uses JWT tokens...

### Express middleware pattern
*Importance: HIGH*
*Discovered by: developer*

The project follows this middleware pattern...
```

**Agent sees the failure reason and can make better decision**.

### Example 2: Task with No Matching Memories

**Scenario**: Task is "Add email notifications"

**Available memories**: All about authentication, nothing about email

**Process**:
```
No memories match "email notifications"
No memories injected
Agent prompt includes only base system prompt
```

**Result**: Agent starts fresh, will likely create new memories about email.

### Example 3: Relevance Scoring

```typescript
// Memory: "Authentication module structure"
// Context: Agent=developer, Task="Implement password reset feature"

Score calculation:
- Importance (high) = 25 points
- Recency (3 days old) = 5 points
- Keyword match ("auth" in task) = 10 points
- Agent tags (developer has "implementation" tag) = 0 points
- Discovered by developer = 10 points
─────────────────────────
Total Score: 50/100

// Memory: "Middleware pattern"
// Same context

Score calculation:
- Importance (high) = 25 points
- Recency (2 weeks old) = 0 points
- Keyword match (no match) = 0 points
- Agent tags (developer has "implementation", memory has "patterns") = 10 points
- Discovered by developer = 10 points
─────────────────────────
Total Score: 45/100

Result: Auth module memory selected (higher score)
```

## Configuration

Memory injection behavior can be configured per agent:

```yaml
# In agent frontmatter
name: developer
memory:
  maxInjected: 5           # Max memories to include
  minImportance: "medium"  # Only high/critical for focused agents
  scoreBonus: 10           # Bonus if agent is specialist
```

## Drawbacks

1. **Pattern matching complexity** - Multiple pattern formats can be confusing
2. **Stale memories** - Old memories might describe outdated code
3. **Memory pollution** - Too many memories can make prompts verbose
4. **Scoring brittleness** - Score weights might need tuning per project
5. **Relevance uncertainty** - Hard to predict what agents will find relevant

## Unresolved Questions

1. **Conflicting memories** - What if two memories contradict?
2. **Temporal ordering** - Should we prioritize recent memories?
3. **Memory caching** - Cache loaded memories for performance?
4. **Negative memories** - How to represent "don't do X"?
5. **Memory deprecation** - Auto-retire old memories?
6. **Feedback loop** - Can we learn which memories are actually useful?
