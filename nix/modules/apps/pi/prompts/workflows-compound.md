---
description: Document a recently solved problem to compound your team's knowledge
argument-hint: "[optional: brief context about the fix]"
---

# /workflows-compound

Document a recently solved problem using parallel subagents to capture institutional knowledge.

## Purpose

Captures problem solutions while context is fresh, creating structured documentation in `docs/` with proper categorization for searchability and future reference.

**Why "compound"?** Each documented solution compounds your team's knowledge. The first time you solve a problem takes research. Document it, and the next occurrence takes minutes.

## Usage

```bash
/workflows-compound                    # Document the most recent fix
/workflows-compound [brief context]    # Provide additional context hint
```

## Execution Strategy: Two-Phase Orchestration

**Only ONE file gets written — the final documentation.**

Phase 1 subagents return TEXT DATA to the orchestrator. They must NOT create any files. Only the orchestrator (Phase 2) writes the final documentation file.

### Phase 1: Parallel Research

Launch these subagents IN PARALLEL. Each returns text data:

```json
{
  "tasks": [
    { "agent": "repo-research-analyst", "task": "Analyze the conversation context. Identify the problem type, component, symptoms. Return a YAML frontmatter skeleton with: date, component, problem_type, severity, tags." },
    { "agent": "senior-developer", "task": "Analyze the investigation steps and solution. Identify root cause and extract the working solution with code examples. Return the solution content as markdown." },
    { "agent": "learnings-researcher", "task": "Search docs/ and specs/ for related documentation. Find cross-references and related ADRs. Return links and relationships." },
    { "agent": "best-practices-researcher", "task": "Develop prevention strategies and best practices guidance for avoiding this issue in future. Return prevention content as markdown." }
  ]
}
```

### Phase 2: Assembly & Write

**WAIT for all Phase 1 subagents to complete.**

1. Collect all text results from Phase 1
2. Determine document type and location:

   | Problem Type | Output Location | Format |
   |---|---|---|
   | Architecture decision | `docs/adr/NNN-title.md` | ADR |
   | Technical design change | `docs/rfc/title.md` | RFC |
   | Bug fix / operational issue | `docs/learnings/category/title.md` | Learning doc |
   | Spec change | `specs/` (update existing) | Spec update |

3. Assemble complete markdown file
4. Create directory if needed: `mkdir -p docs/learnings/[category]/`
5. Write the SINGLE final file

### Phase 3: Optional Enhancement

Based on problem type, optionally invoke specialized agents to review:

- **performance issue** → `performance-oracle`
- **security issue** → `security-sentinel`
- **pattern violation** → `pattern-recognition-specialist`

## What It Captures

- **Problem symptom**: Exact error messages, observable behavior
- **Investigation steps**: What didn't work and why
- **Root cause analysis**: Technical explanation
- **Working solution**: Step-by-step fix with code examples
- **Prevention strategies**: How to avoid in future
- **Cross-references**: Links to related ADRs, specs, and docs

## Preconditions

- Problem has been solved (not in-progress)
- Solution has been verified working
- Non-trivial problem (not simple typo or obvious error)

## Learning Doc Categories

Organized under `docs/learnings/`:

- `performance/` — N+1 queries, memory leaks, slow algorithms
- `security/` — Vulnerabilities, auth issues, data exposure
- `correctness/` — Logic errors, race conditions, data corruption
- `config/` — Configuration mistakes, environment issues
- `integration/` — External service issues, API changes
- `operations/` — Deployment issues, monitoring gaps

## Success Output

```
✓ Documentation complete

Subagent Results:
  ✓ repo-research-analyst: Identified performance issue in [component]
  ✓ senior-developer: 3 code fixes extracted
  ✓ learnings-researcher: 2 related ADRs found
  ✓ best-practices-researcher: Prevention strategies ready

File created:
- docs/learnings/performance/n-plus-one-query-fix.md

What's next?
1. Continue workflow (recommended)
2. Link related documentation
3. View documentation
4. Other
```

## The Compounding Philosophy

```
Build → Test → Find Issue → Research → Fix → Document → Deploy
    ↑                                                       ↓
    └───────────────────────────────────────────────────────┘
```

**Each unit of engineering work should make subsequent units of work easier — not harder.**

## Auto-Invoke Triggers

- "that worked"
- "it's fixed"
- "working now"
- "problem solved"

## Related Commands

- `/workflows-plan` — Planning workflow (references documented decisions)
- `/workflows-review` — Code review (searches docs/ for patterns)
- `/skill:compound-docs` — Detailed skill for documentation capture
