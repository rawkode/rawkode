---
name: document-review
description: Structured self-review process for brainstorm, plan, spec, or ADR documents. Use when a document exists and needs refinement before proceeding to the next workflow step.
---

# Document Review

Improve documents through structured review. Works on brainstorms, plans, specs, ADRs, and RFCs.

## Step 1: Get the Document

**If a document path is provided:** Read it, then proceed to Step 2.

**If no document is specified:** Ask which document to review, or look for the most recent document in `docs/brainstorms/`, `docs/adr/`, `docs/rfc/`, or `specs/`.

## Step 2: Assess

Read through the document and ask:

- What is unclear?
- What is unnecessary?
- What decision is being avoided?
- What assumptions are unstated?
- Where could scope accidentally expand?

These questions surface issues. Don't fix yet — just note what you find.

## Step 3: Evaluate

Score the document against these criteria:

| Criterion | What to Check |
|-----------|---------------|
| **Clarity** | Problem statement is clear, no vague language ("probably," "consider," "try to") |
| **Completeness** | Required sections present, constraints stated, open questions flagged |
| **Specificity** | Concrete enough for next step (brainstorm → can plan, plan → can implement, spec → can build) |
| **YAGNI** | No hypothetical features, simplest approach chosen |

If invoked within a workflow, also check:
- **User intent fidelity** — Document reflects what was discussed, assumptions validated

## Step 4: Identify the Critical Improvement

Among everything found, does one issue stand out? If something would significantly improve the document's quality, highlight it as the "must address" item.

## Step 5: Make Changes

Present your findings, then:

1. **Auto-fix** minor issues (vague language, formatting) without asking
2. **Ask approval** before substantive changes (restructuring, removing sections, changing meaning)
3. **Update** the document inline — no separate files, no metadata sections

### Simplification Guidance

**Simplify when:**
- Content serves hypothetical future needs, not current ones
- Sections repeat information already covered elsewhere
- Detail exceeds what's needed for the next step
- Abstractions add overhead without clarity

**Don't simplify:**
- Constraints or edge cases that affect implementation
- Rationale explaining why alternatives were rejected
- Open questions that need resolution

## Step 6: Offer Next Action

After changes are complete, ask:

1. **Refine again** — Another review pass
2. **Review complete** — Document is ready

After 2 refinement passes, recommend completion — diminishing returns are likely.

## What NOT to Do

- Do not rewrite the entire document
- Do not add new sections or requirements the user didn't discuss
- Do not over-engineer or add complexity
- Do not create separate review files or add metadata sections
