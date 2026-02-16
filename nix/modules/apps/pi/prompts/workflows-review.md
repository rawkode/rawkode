---
description: Perform code reviews using multi-agent analysis
argument-hint: "[PR number, GitHub URL, branch name, or latest]"
---

# Review Command

Perform code reviews using multi-agent analysis for deep inspection.

## Prerequisites

- Git repository with GitHub CLI (`gh`) installed and authenticated
- Clean main/master branch

## Main Tasks

### 1. Determine Review Target & Setup

<review_target> #$ARGUMENTS </review_target>

- Determine review type: PR number (numeric), GitHub URL, file path (.md), or empty (current branch)
- Check current git branch
- If already on the target branch → proceed with analysis
- If different branch → offer to checkout or create worktree
- Fetch PR metadata using `gh pr view --json` for title, body, files, linked issues
- Make sure we are on the branch we are reviewing

### 2. Load Review Agents

Dispatch parallel review agents:

```json
{
  "tasks": [
    { "agent": "code-quality-reviewer", "task": "Review this PR for correctness, security, and resilience. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "senior-developer", "task": "Review this PR for engineering quality, architecture fit, and maintainability. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "design-reviewer", "task": "Review this PR for design quality, API contracts, and performance. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "security-sentinel", "task": "Review this PR for security vulnerabilities, input validation, and secrets exposure. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "performance-oracle", "task": "Review this PR for performance bottlenecks, algorithmic complexity, and resource usage. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "pattern-recognition-specialist", "task": "Review this PR for anti-patterns, naming consistency, and code duplication. End with: VERDICT: APPROVE or VERDICT: REWORK" },
    { "agent": "learnings-researcher", "task": "Search docs/ and specs/ for past decisions related to this PR's modules and patterns. Report relevant institutional knowledge." }
  ]
}
```

### 3. Conditional Agents

**If PR contains database migrations or schema changes:**

```json
{
  "tasks": [
    { "agent": "ops-reviewer", "task": "Review database migration safety, rollback procedures, and deployment checklist. End with: VERDICT: APPROVE or VERDICT: REWORK" }
  ]
}
```

### 4. Deep Dive Analysis

#### Stakeholder Perspectives

1. **Developer**: How easy is this to understand and modify? APIs intuitive? Debugging straightforward?
2. **Operations**: How to deploy safely? What metrics/logs available? Resource requirements?
3. **End User**: Feature intuitive? Error messages helpful? Performance acceptable?
4. **Security**: Attack surface? Compliance requirements? Data protection?

#### Scenario Exploration

- [ ] Happy Path: Normal operation with valid inputs
- [ ] Invalid Inputs: Null, empty, malformed data
- [ ] Boundary Conditions: Min/max values, empty collections
- [ ] Concurrent Access: Race conditions, deadlocks
- [ ] Network Issues: Timeouts, partial failures
- [ ] Resource Exhaustion: Memory, disk, connections

### 5. Findings Synthesis

Consolidate all agent reports:

- Surface learnings-researcher results: flag as "Known Pattern" with links to docs/
- Categorize by type: security, performance, architecture, quality
- Assign severity: 🔴 CRITICAL (P1), 🟡 IMPORTANT (P2), 🔵 NICE-TO-HAVE (P3)
- Remove duplicates
- Estimate effort for each finding (Small/Medium/Large)

### 6. Summary Report

```markdown
## ✅ Code Review Complete

**Review Target:** PR #XXXX - [PR Title]
**Branch:** [branch-name]

### Findings Summary:
- **Total Findings:** [X]
- **🔴 CRITICAL (P1):** [count] — BLOCKS MERGE
- **🟡 IMPORTANT (P2):** [count] — Should Fix
- **🔵 NICE-TO-HAVE (P3):** [count] — Enhancements

### Review Agents Used:
- code-quality-reviewer
- senior-developer
- design-reviewer
- security-sentinel
- performance-oracle
- pattern-recognition-specialist
- learnings-researcher

### Next Steps:
1. Address P1 Findings (must fix before merge)
2. Triage P2/P3 findings
3. Run tests to verify fixes
```

### Important: P1 Findings Block Merge

Any **🔴 P1 (CRITICAL)** findings must be addressed before merging. Present these prominently.
