# ADR-0005: LLM-Based Arbiter

## Status

Accepted (2026-01-23)

## Context

rawko-sdk needs a mechanism to decide:

1. **Mode Selection**: Which agent to activate for the current task state
2. **Progress Evaluation**: Whether to continue, retry, or complete
3. **Error Recovery**: How to respond to failures

The original rawko used an LLM-based arbiter that made these decisions by analyzing the task context, plan state, and execution history. This approach proved effective for handling nuanced, context-dependent decisions.

Alternatives include:
- Rule-based systems (if-then logic)
- Fixed workflows (predetermined agent sequences)
- User-driven selection (manual mode switching)

## Decision

Retain the **LLM-based arbiter** approach for intelligent mode transitions and progress evaluation.

### Arbiter Responsibilities

1. **SELECT_MODE**: Choose the next agent based on task state
2. **CONTINUE**: Agent should continue working
3. **COMPLETE**: Task is finished
4. **RETRY**: Current agent should retry with different approach

### Arbiter Interface

```typescript
interface Arbiter {
  selectAgent(input: SelectAgentInput): Promise<ArbiterDecision>;
  evaluateProgress(input: EvaluateProgressInput): Promise<ArbiterDecision>;
}

interface SelectAgentInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastError: Error | null;
  availableAgents: AgentConfig[];
}

interface EvaluateProgressInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastExecution: ExecutionEntry;
}

type ArbiterDecision =
  | { type: "SELECT_MODE"; mode: string; reason: string }
  | { type: "CONTINUE"; reason: string }
  | { type: "COMPLETE"; summary: string }
  | { type: "RETRY"; reason: string };
```

## Consequences

### Positive

- **Context-aware decisions** - LLM understands nuanced task requirements
- **Adaptive workflows** - Not locked into predetermined sequences
- **Natural language reasoning** - Decision logic is explainable
- **Handles edge cases** - Can reason about unexpected situations
- **Leverages agent descriptions** - Uses `whenToUse` fields for informed selection

### Negative

- **Latency overhead** - Each decision requires an LLM call
- **Cost** - Additional API calls increase usage costs
- **Non-determinism** - Same input may produce different decisions
- **Prompt engineering** - Arbiter effectiveness depends on prompt quality
- **Debugging difficulty** - Harder to trace decision logic than rules

## Alternatives Considered

### Rule-Based System

**Approach**: Define explicit rules for transitions

```typescript
const rules = [
  { when: "plan is null", select: "planner" },
  { when: "all steps complete", select: "complete" },
  { when: "tests failed", select: "developer" },
];
```

**Pros**: Deterministic, fast, no API calls
**Cons**: Cannot handle novel situations, brittle, requires anticipating all cases

**Rejected because**: Software tasks are too varied; rules cannot capture all valid decision paths.

### Fixed Workflows

**Approach**: Predetermined agent sequences

```
planner → developer → tester → reviewer → complete
```

**Pros**: Predictable, simple to understand
**Cons**: Inflexible, cannot skip unnecessary steps, cannot adapt to task type

**Rejected because**: Different tasks need different workflows (bug fix vs. new feature vs. refactor).

### User-Driven Selection

**Approach**: User manually selects next mode

**Pros**: Maximum control, no wrong decisions
**Cons**: Requires constant attention, defeats automation purpose

**Rejected because**: Goal is autonomous task completion with minimal user intervention.

### Hybrid Approach (Considered for Future)

**Approach**: Rules for common cases, LLM for edge cases

**Pros**: Fast for simple decisions, intelligent for complex ones
**Cons**: Complexity of maintaining both systems

**Noted for future**: May implement as optimization after baseline works.

## Implementation Notes

### Arbiter Configuration

```yaml
# .rawko/config.yaml
arbiter:
  provider: claude
  model: claude-haiku-4  # Fast, cheap model for decisions
  maxTokens: 1024
  temperature: 0.3  # Lower temperature for consistent decisions
```

### Arbiter Prompt Template

```typescript
const ARBITER_SELECT_PROMPT = `
You are the arbiter for a software development task. Analyze the current state and decide which agent should work next.

## Task
{task}

## Current Plan
{plan}

## Execution History
{history}

## Available Agents
{agents}

## Last Error (if any)
{lastError}

## Instructions
Based on the task state, select the most appropriate agent. Consider:
- Is planning needed? Use 'planner'
- Is implementation needed? Use 'developer'
- Should we run tests? Use 'tester'
- Is review needed? Use 'reviewer'
- Is the task complete? Return COMPLETE

Respond with JSON:
{
  "decision": "SELECT_MODE" | "COMPLETE" | "RETRY",
  "mode": "agent_name",  // if SELECT_MODE
  "reason": "brief explanation"
}
`;

const ARBITER_EVALUATE_PROMPT = `
You are evaluating progress on a software development task.

## Task
{task}

## Plan
{plan}

## Last Execution
{lastExecution}

## Full History
{history}

## Instructions
Determine if the task should continue, is complete, or needs retry.

Respond with JSON:
{
  "decision": "CONTINUE" | "COMPLETE" | "RETRY",
  "reason": "brief explanation",
  "summary": "task summary"  // if COMPLETE
}
`;
```

### Arbiter Implementation

```typescript
class LLMArbiter implements Arbiter {
  private session: ProviderSession;

  constructor(
    private provider: Provider,
    private config: ArbiterConfig
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.provider.createSession({
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      systemPrompt: "You are an arbiter making decisions about task execution. Always respond with valid JSON.",
    });
  }

  async selectAgent(input: SelectAgentInput): Promise<ArbiterDecision> {
    const prompt = this.buildSelectPrompt(input);

    let response = "";
    for await (const event of this.session.sendMessage({
      role: "user",
      content: prompt,
    })) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
    }

    return this.parseDecision(response);
  }

  async evaluateProgress(input: EvaluateProgressInput): Promise<ArbiterDecision> {
    const prompt = this.buildEvaluatePrompt(input);

    let response = "";
    for await (const event of this.session.sendMessage({
      role: "user",
      content: prompt,
    })) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
    }

    return this.parseDecision(response);
  }

  private buildSelectPrompt(input: SelectAgentInput): string {
    const agentsDescription = input.availableAgents
      .map((a) => `- ${a.name}: ${a.whenToUse || a.displayName || "No description"}`)
      .join("\n");

    return ARBITER_SELECT_PROMPT
      .replace("{task}", input.task)
      .replace("{plan}", JSON.stringify(input.plan, null, 2))
      .replace("{history}", this.formatHistory(input.history))
      .replace("{agents}", agentsDescription)
      .replace("{lastError}", input.lastError?.message ?? "None");
  }

  private parseDecision(response: string): ArbiterDecision {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Arbiter did not return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    switch (parsed.decision) {
      case "SELECT_MODE":
        return { type: "SELECT_MODE", mode: parsed.mode, reason: parsed.reason };
      case "CONTINUE":
        return { type: "CONTINUE", reason: parsed.reason };
      case "COMPLETE":
        return { type: "COMPLETE", summary: parsed.summary || parsed.reason };
      case "RETRY":
        return { type: "RETRY", reason: parsed.reason };
      default:
        throw new Error(`Unknown arbiter decision: ${parsed.decision}`);
    }
  }
}
```

### Using Different Provider for Arbiter

The arbiter can use a different (often cheaper/faster) model than the main agents:

```yaml
# .rawko/config.yaml
provider:
  default: copilot
  copilot:
    model: gpt-4

arbiter:
  provider: claude
  model: claude-haiku-4  # Cheaper for quick decisions
```

### Caching Considerations

For repeated similar decisions, consider caching:

```typescript
class CachedArbiter implements Arbiter {
  private cache = new Map<string, ArbiterDecision>();

  async selectAgent(input: SelectAgentInput): Promise<ArbiterDecision> {
    const cacheKey = this.computeCacheKey(input);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const decision = await this.delegate.selectAgent(input);
    this.cache.set(cacheKey, decision);
    return decision;
  }
}
```

### Fallback Behavior

If the arbiter fails, fall back to deterministic logic:

```typescript
async function selectAgentWithFallback(input: SelectAgentInput): Promise<ArbiterDecision> {
  try {
    return await arbiter.selectAgent(input);
  } catch (error) {
    console.warn("Arbiter failed, using fallback logic:", error);

    // Fallback: simple rule-based selection
    if (!input.plan) {
      return { type: "SELECT_MODE", mode: "planner", reason: "No plan exists (fallback)" };
    }
    if (input.lastError) {
      return { type: "RETRY", reason: "Error occurred (fallback)" };
    }
    return { type: "SELECT_MODE", mode: "developer", reason: "Default to developer (fallback)" };
  }
}
```

See [SPEC-0001: Core Architecture](../specs/0001-core-architecture.md) for how the arbiter integrates with the overall system.
