---
name: compound-docs
description: Capture solved problems as ADRs, specs, or knowledge docs in docs/ and specs/ for fast institutional lookup. Use after solving non-trivial problems to compound team knowledge.
---

# Compound Docs

**Purpose:** Document solved problems to build searchable institutional knowledge. Each documented solution compounds your team's knowledge — the first time takes research, the second time takes minutes.

## When to Use

- After solving a non-trivial problem (multiple investigation attempts, tricky debugging)
- After making architectural decisions that should be recorded
- When a solution has prevention value for future work

**Skip for:** Simple typos, obvious syntax errors, trivial fixes.

## Process

### Step 1: Detect Confirmation

Auto-invoke after phrases like "that worked", "it's fixed", "working now", "problem solved".

Or invoke manually: `/skill:compound-docs`

### Step 2: Gather Context

Extract from conversation history:

- **Component**: Which module or area had the problem
- **Symptom**: Observable error/behavior (exact messages)
- **Investigation**: What didn't work and why
- **Root cause**: Technical explanation
- **Solution**: What fixed it (code/config changes)
- **Prevention**: How to avoid in future

If critical context is missing, ask the user before proceeding.

### Step 3: Check Existing Docs

Search for similar documented issues:

```bash
grep -ril "keyword" docs/ specs/
```

If a similar issue exists, ask:
1. Create new doc with cross-reference (recommended)
2. Update existing doc (only if same root cause)

### Step 4: Classify and Route

Determine the document type based on what was solved:

| Problem Type | Output Location | Format |
|---|---|---|
| Architecture decision | `docs/adr/NNN-title.md` | ADR (Michael Nygard template) |
| Technical design change | `docs/rfc/title.md` | RFC |
| Bug fix / operational issue | `docs/learnings/category/title.md` | Learning doc |
| Requirement change | `specs/requirements/` (update existing or new file) | Requirement doc |
| Spec change | `specs/specifications/` (update existing or new file) | Spec update |

### Step 5: Write Documentation

**For ADRs** (`docs/adr/`):

```markdown
# ADR-NNN: [Title]

## Status
Accepted

## Context
[What issue motivated this decision]

## Decision
[What we decided and why]

## Consequences
### Positive
### Negative
### Neutral

## Alternatives Considered
```

**For Learning Docs** (`docs/learnings/`):

```markdown
---
date: YYYY-MM-DD
component: [component name]
problem_type: [performance|security|correctness|config|integration]
severity: [critical|high|medium|low]
tags: [searchable keywords]
---

# [Title]

## Problem
[Exact error messages, observable behavior]

## Investigation
[What was tried and why it didn't work]

## Root Cause
[Technical explanation]

## Solution
[Code/config changes with examples]

## Prevention
[How to avoid in future]

## Related
[Links to related docs, issues, or ADRs]
```

### Step 6: Cross-Reference

- Link to related existing docs
- If this is the 3rd+ instance of a pattern, create a pattern doc in `docs/learnings/patterns/`

### Step 7: Offer Next Steps

```
✓ Documentation complete

File created: [path]

What's next?
1. Continue workflow (recommended)
2. Link related documentation
3. View documentation
4. Other
```

## Categories for Learning Docs

Organized under `docs/learnings/`:

- `performance/` — N+1 queries, memory leaks, slow algorithms
- `security/` — Vulnerabilities, auth issues, data exposure
- `correctness/` — Logic errors, race conditions, data corruption
- `config/` — Configuration mistakes, environment issues
- `integration/` — External service issues, API changes
- `operations/` — Deployment issues, monitoring gaps

## Quality Guidelines

**Good documentation has:**
- ✅ Exact error messages (copy-paste from output)
- ✅ Specific file/line references
- ✅ Observable symptoms (what you saw, not interpretations)
- ✅ Failed attempts documented (helps avoid wrong paths)
- ✅ Technical explanation (not just "what" but "why")
- ✅ Code examples (before/after if applicable)
- ✅ Prevention guidance

**Avoid:**
- ❌ Vague descriptions ("something was wrong")
- ❌ Missing technical details ("fixed the code")
- ❌ No context (which version? which file?)
- ❌ Just code dumps (explain why it works)
