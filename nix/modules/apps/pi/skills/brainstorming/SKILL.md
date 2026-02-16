---
name: brainstorming
description: Structured brainstorming process for exploring requirements and approaches before planning. Use when feature ideas are vague, multiple approaches exist, or trade-offs need exploration.
---

# Brainstorming

Detailed process knowledge for effective brainstorming sessions that clarify **WHAT** to build before diving into **HOW** to build it.

## When to Use

Brainstorming is valuable when:
- Requirements are unclear or ambiguous
- Multiple approaches could solve the problem
- Trade-offs need to be explored with the user
- The user hasn't fully articulated what they want
- The feature scope needs refinement

**Skip when:** Requirements are explicit, the user knows exactly what they want, or it's a straightforward bug fix.

## Phase 0: Assess Requirement Clarity

**Signals requirements are clear** (skip brainstorming):
- Specific acceptance criteria provided
- Referenced existing patterns to follow
- Described exact expected behavior
- Constrained, well-defined scope

**Signals brainstorming is needed:**
- Vague terms ("make it better", "add something like")
- Multiple reasonable interpretations
- Trade-offs haven't been discussed
- User seems unsure about the approach

## Phase 1: Understand the Idea

Ask questions **one at a time**. Don't overwhelm.

### Question Techniques

1. **Prefer multiple choice when natural options exist**
   - "Should this be (a) real-time push, (b) polling, or (c) on-demand?"
   - Not: "How should updates be delivered?"

2. **Start broad, then narrow**
   - First: "Who is this for? What problem does it solve?"
   - Then: "What happens at the edge? What if X fails?"

3. **Validate assumptions explicitly**
   - "I'm assuming this only applies to authenticated users — is that right?"

4. **Ask about success criteria**
   - "How will you know this worked? What does success look like?"

5. **Probe for constraints**
   - "Are there performance requirements? Budget? Timeline?"
   - "What existing systems does this interact with?"

6. **Explore boundaries**
   - "What should this explicitly NOT do?"
   - "Where does this feature's responsibility end?"

### Exit Condition
Continue until the idea is clear OR user says "proceed."

## Phase 2: Explore Approaches

Propose **2-3 concrete approaches** based on research and conversation.

For each approach, provide:
- Brief description (2-3 sentences)
- Pros and cons
- When it's the best fit
- Rough complexity estimate

**Lead with your recommendation** and explain why. Apply YAGNI — prefer simpler solutions.

### YAGNI Checklist
Before recommending an approach, ask:
- Does this solve the problem as stated, or a hypothetical future problem?
- Is there a simpler version that delivers 80% of the value?
- Are we adding abstraction for a case that may never happen?
- Would a junior developer understand this in 5 minutes?

## Phase 3: Capture the Design

Write a brainstorm document to `docs/brainstorms/YYYY-MM-DD-<topic>.md`:

```markdown
---
date: YYYY-MM-DD
topic: [brief topic description]
status: complete
---

# [Topic Title]

## What We're Building
[Clear statement of what and for whom]

## Why This Approach
[Chosen approach and reasoning]

## Key Decisions
- [Decision 1]: [choice] because [reason]
- [Decision 2]: [choice] because [reason]

## Open Questions
- [Question that still needs resolution]

## Resolved Questions
- [Question]: [Answer reached during brainstorm]

## Approaches Considered
### [Approach 1]
- Description, pros, cons, why chosen/rejected

### [Approach 2]
- Description, pros, cons, why chosen/rejected
```

**Before proceeding:** If there are open questions, ask the user about each one. Move resolved questions to the "Resolved Questions" section.

## Phase 4: Handoff

Offer next steps:
1. **Review and refine** — Apply the document-review skill
2. **Proceed to planning** — The plan workflow will auto-detect this brainstorm
3. **Ask more questions** — Return to Phase 1 for deeper exploration
4. **Done for now** — Return later

## Important Guidelines

- **Stay focused on WHAT, not HOW** — Implementation details belong in the plan
- **Ask one question at a time** — Don't overwhelm
- **Apply YAGNI** — Prefer simpler approaches
- **Keep outputs concise** — 200-300 words per section max
- **NEVER CODE** — Just explore and document decisions
