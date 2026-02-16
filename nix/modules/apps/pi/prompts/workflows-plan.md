---
description: Transform feature descriptions into well-structured project plans following conventions
argument-hint: "[feature description, bug report, or improvement idea]"
---

# Create a plan for a new feature or bug fix

## Introduction

**Note: The current year is 2026.** Use this when dating plans and searching for recent documentation.

Transform feature descriptions, bug reports, or improvement ideas into well-structured markdown files that follow project conventions and best practices.

## Feature Description

<feature_description> #$ARGUMENTS </feature_description>

**If the feature description above is empty, ask the user:** "What would you like to plan? Please describe the feature, bug fix, or improvement you have in mind."

Do not proceed until you have a clear feature description from the user.

### 0. Idea Refinement

**Check for brainstorm output first:**

Before asking questions, look for recent brainstorm documents in `docs/brainstorms/` that match this feature:

```bash
ls -la docs/brainstorms/*.md 2>/dev/null | head -10
```

**Relevance criteria:** A brainstorm is relevant if:
- The topic (from filename or YAML frontmatter) semantically matches the feature description
- Created within the last 14 days
- If multiple candidates match, use the most recent one

**If a relevant brainstorm exists:**
1. Read the brainstorm document
2. Announce: "Found brainstorm from [date]: [topic]. Using as context for planning."
3. Extract key decisions, chosen approach, and open questions
4. **Skip the idea refinement questions below** — the brainstorm already answered WHAT to build
5. Use brainstorm decisions as input to the research phase

**If no brainstorm found, run idea refinement:**

Refine the idea through collaborative dialogue:

- Ask questions one at a time to understand the idea fully
- Prefer multiple choice questions when natural options exist
- Focus on understanding: purpose, constraints, and success criteria
- Continue until the idea is clear OR user says "proceed"

**Gather signals for research decision.** During refinement, note:

- **User's familiarity**: Do they know the codebase patterns?
- **Topic risk**: Security, payments, external APIs warrant more caution
- **Uncertainty level**: Is the approach clear or open-ended?

## Main Tasks

### 1. Local Research (Always Runs — Parallel)

Run these agents **in parallel** to gather local context:

```json
{
  "tasks": [
    { "agent": "repo-research-analyst", "task": "Analyze repository structure and patterns related to: <feature_description>" },
    { "agent": "learnings-researcher", "task": "Search docs/ and specs/ for relevant past decisions, ADRs, and institutional knowledge related to: <feature_description>" }
  ]
}
```

### 1.5. Research Decision

Based on signals from Step 0 and findings from Step 1, decide on external research.

**High-risk topics → always research.** Security, payments, external APIs, data privacy.
**Strong local context → skip external research.** Codebase has good patterns, AGENTS.md has guidance.
**Uncertainty or unfamiliar territory → research.**

### 1.5b. External Research (Conditional)

**Only run if Step 1.5 indicates external research is valuable.**

```json
{
  "tasks": [
    { "agent": "best-practices-researcher", "task": "Research best practices for: <feature_description>" }
  ]
}
```

### 1.6. Consolidate Research

- Document relevant file paths from repo research
- Include relevant institutional learnings from `docs/` and `specs/`
- Note external documentation URLs and best practices (if external research was done)
- Capture AGENTS.md conventions

### 2. Issue Planning & Structure

**Title & Categorization:**

- Draft clear, searchable issue title using conventional format (e.g., `feat: Add user authentication`)
- Determine issue type: enhancement, bug, refactor
- Convert title to filename: date prefix, strip prefix colon, kebab-case, add `-plan` suffix
  - Example: `feat: Add User Authentication` → `2026-01-21-feat-add-user-authentication-plan.md`

### 3. Choose Implementation Detail Level

#### 📄 MINIMAL — Simple bugs, small improvements

```markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
---

# [Issue Title]

[Brief problem/feature description]

## Acceptance Criteria
- [ ] Core requirement 1
- [ ] Core requirement 2

## Context
[Any critical information]

## References
- Related issue: #[issue_number]
```

#### 📋 MORE — Most features, complex bugs

Includes everything from MINIMAL plus: detailed background, technical considerations, success metrics, dependencies and risks.

#### 📚 A LOT — Major features, architectural changes

Includes everything from MORE plus: phased implementation plan, alternatives considered, extensive technical specs, risk analysis, resource requirements.

### 4. Issue Creation & Formatting

- Use clear, descriptive headings with proper hierarchy
- Include code examples with syntax highlighting
- Use task lists for trackable items
- Add collapsible sections for lengthy content
- Cross-reference related issues/PRs

### 5. Final Review

- Title is searchable and descriptive
- All template sections are complete
- Acceptance criteria are measurable
- Add ERD mermaid diagram if applicable for new model changes

## Output Format

```
docs/plans/YYYY-MM-DD-<type>-<descriptive-name>-plan.md
```

## Post-Generation Options

After writing the plan file, present these options:

1. **Open plan in editor** — Open the plan file for review
2. **Run `/deepen-plan`** — Enhance each section with parallel research agents
3. **Review and refine** — Improve the document through structured self-review (load `document-review` skill)
4. **Start `/workflows-work`** — Begin implementing this plan
5. **Create Issue** — Create issue in project tracker (GitHub)

NEVER CODE! Just research and write the plan.
