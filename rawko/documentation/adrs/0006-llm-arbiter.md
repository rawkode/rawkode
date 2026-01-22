# ADR-0006: LLM Arbiter

## Status

Accepted

## Context

rawko needs to decide which agent handles a task and when to transition between agents. This routing logic must:

- Understand task requirements
- Know agent capabilities
- Handle ambiguous situations
- Adapt to context and history
- Decide when tasks are complete

Routing approaches considered:
- LLM-based arbiter
- Rule-based routing
- Keyword matching
- User-directed routing
- Fixed workflows

## Decision

We will use an LLM-based arbiter to make agent selection and routing decisions.

## Consequences

### Positive

**Flexible Routing**
- Handles novel task types
- No predefined rules needed
- Adapts to context
- Works with natural language tasks

**Ambiguity Handling**
- Can interpret unclear requests
- Weighs multiple factors
- Makes judgment calls
- Explains decisions

**Context Awareness**
- Considers task history
- Understands agent outputs
- Tracks progress
- Remembers failures

**Intelligent Completion**
- Knows when task is done
- Understands quality criteria
- Can request revisions
- Handles partial success

**Natural Evolution**
- Prompt engineering improves routing
- No code changes for better decisions
- Can incorporate feedback
- Learns from patterns via prompt

### Negative

**Latency**
- LLM call for every decision
- Adds overhead between agents
- Streaming doesn't help (need full decision)
- Could add seconds to simple tasks

**Cost**
- Additional API calls
- Token usage for context
- Scales with task complexity
- Cost per decision

**Unpredictability**
- LLM decisions may vary
- Same input might route differently
- Harder to test deterministically
- Debugging routing issues complex

**Failure Mode**
- LLM errors halt execution
- Rate limits affect routing
- API outages stop work
- Must handle gracefully

**Complexity**
- Arbiter prompt is critical
- Must maintain context window
- Tricky to get right
- Another LLM to configure

## Alternatives Considered

### Rule-based Routing

Define explicit rules for agent selection.

```
IF task contains "bug" OR "fix" THEN developer
IF task contains "review" THEN reviewer
IF task contains "plan" THEN planner
```

Pros:
- Deterministic
- Fast (no LLM call)
- Easy to test
- Predictable

Cons:
- Brittle to phrasing
- Requires extensive rules
- Doesn't handle novel cases
- Must anticipate all patterns

Rejected because: Can't handle the variety of natural language tasks.

### Keyword Matching

Route based on detected keywords/intent.

Pros:
- Fast
- Simple implementation
- No LLM needed

Cons:
- False positives
- Misses context
- Keyword overlap
- Poor handling of complex tasks

Rejected because: Too simplistic for multi-agent orchestration.

### User-Directed Routing

Let user explicitly choose agents.

```bash
rawko --agent developer "implement feature"
rawko --agent reviewer "check my changes"
```

Pros:
- Predictable
- User control
- No routing errors
- Simple

Cons:
- Burden on user
- Defeats purpose of automation
- User must know agents
- No multi-agent workflows

Rejected because: Removes the intelligence from agentic orchestration.

### Fixed Workflows

Predefined sequences of agents.

```
Task → Planner → Developer → Reviewer → Done
```

Pros:
- Predictable
- Easy to understand
- No routing logic
- Simple to implement

Cons:
- Inflexible
- Can't adapt to task type
- Wasteful for simple tasks
- Can't handle failures gracefully

Rejected because: Different tasks need different workflows.

### Hybrid Approach (Deferred)

Combine rules with LLM fallback.

Pros:
- Fast for common cases
- LLM for edge cases
- Lower cost
- Predictable when possible

Could be implemented later if:
- Latency becomes problematic
- Cost is too high
- Common patterns emerge

## Implementation

### Arbiter Prompt Structure

```
You are the arbiter for rawko, an agentic coding system. Your role is to:
1. Select which agent should handle the current task or subtask
2. Evaluate agent outputs and decide next steps
3. Determine when a task is complete

Available agents:
{agent_descriptions}

Current task: {task_description}

Conversation history:
{history}

Last agent output:
{last_output}

Decide the next action:
- SELECT <agent_name>: Route to an agent
- COMPLETE: Task is finished
- RETRY <agent_name>: Retry with additional guidance

Respond with your decision and brief reasoning.
```

### Decision Format

```json
{
  "action": "SELECT",
  "agent": "developer",
  "reason": "Plan is clear, code changes needed",
  "guidance": "Focus on the auth module first"
}
```

### Error Handling

```rust
async fn arbiter_decide(&self, context: &Context) -> Result<Decision> {
    let mut retries = 3;

    loop {
        match self.call_arbiter_llm(context).await {
            Ok(decision) => return Ok(decision),
            Err(e) if retries > 0 => {
                retries -= 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(e) => return Err(e),
        }
    }
}
```

## Notes

- Arbiter uses separate LLM config from agents
- Consider using faster/cheaper model for arbiter
- Context window management critical for long tasks
- Arbiter decisions are traced for debugging
