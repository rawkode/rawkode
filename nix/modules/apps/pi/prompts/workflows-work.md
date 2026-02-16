---
description: Execute work plans efficiently while maintaining quality and finishing features
argument-hint: "[plan file, specification, or todo file path]"
---

# Work Plan Execution Command

Execute a work plan efficiently while maintaining quality and finishing features.

## Input Document

<input_document> #$ARGUMENTS </input_document>

## Execution Workflow

### Phase 1: Quick Start

1. **Read Plan and Clarify**
   - Read the work document completely
   - Review any references or links provided in the plan
   - If anything is unclear or ambiguous, ask clarifying questions now
   - Get user approval to proceed

2. **Setup Environment**

   Check the current branch:
   ```bash
   current_branch=$(git branch --show-current)
   default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
   if [ -z "$default_branch" ]; then
     default_branch=$(git rev-parse --verify origin/main >/dev/null 2>&1 && echo "main" || echo "master")
   fi
   ```

   **If already on a feature branch**: Ask to continue or create new.
   **If on default branch**: Create a feature branch with a meaningful name.

3. **Create Task List**
   - Break plan into actionable tasks
   - Include dependencies between tasks
   - Include testing and quality check tasks

### Phase 2: Execute

1. **Task Execution Loop**

   For each task in priority order:
   - Mark task as in_progress
   - Read any referenced files from the plan
   - Look for similar patterns in codebase
   - Implement following existing conventions
   - Write tests for new functionality
   - Run tests after changes
   - Mark task as completed
   - Mark off the corresponding checkbox in the plan file (`[ ]` → `[x]`)
   - Evaluate for incremental commit

2. **Incremental Commits**

   | Commit when... | Don't commit when... |
   |---|---|
   | Logical unit complete | Small part of a larger unit |
   | Tests pass + meaningful progress | Tests failing |
   | About to switch contexts | Purely scaffolding with no behavior |
   | About to attempt risky changes | Would need a "WIP" message |

   ```bash
   git add <files related to this logical unit>
   git commit -m "feat(scope): description of this unit"
   ```

3. **Follow Existing Patterns**
   - Read referenced similar code first
   - Match naming conventions exactly
   - Reuse existing components where possible
   - Follow project coding standards (see AGENTS.md)

4. **Test Continuously**
   - Run relevant tests after each significant change
   - Fix failures immediately
   - Add new tests for new functionality

### Phase 3: Quality Check

1. **Run Core Quality Checks**
   ```bash
   # Run full test suite (use project's test command)
   # Run linting (per AGENTS.md)
   ```

2. **Consider Reviewer Agents** (Optional — for complex/risky changes)

   ```json
   {
     "tasks": [
       { "agent": "code-quality-reviewer", "task": "Review the implementation for correctness and quality" },
       { "agent": "security-sentinel", "task": "Review for security vulnerabilities" },
       { "agent": "performance-oracle", "task": "Review for performance issues" }
     ]
   }
   ```

3. **Final Validation**
   - All tasks marked completed
   - All tests pass
   - Linting passes
   - Code follows existing patterns

### Phase 4: Ship It

1. **Create Commit**
   ```bash
   git add .
   git commit -m "feat(scope): description of what and why"
   ```

2. **Create Pull Request**
   ```bash
   git push -u origin feature-branch-name
   gh pr create --title "Feature: [Description]" --body "$(cat <<'EOF'
   ## Summary
   - What was built
   - Why it was needed
   - Key decisions made

   ## Testing
   - Tests added/modified
   - Manual testing performed

   ## Post-Deploy Monitoring & Validation
   - What to monitor
   - Expected healthy behavior
   - Failure signals / rollback trigger
   EOF
   )"
   ```

3. **Update Plan Status**
   If the input document has YAML frontmatter with a `status` field, update to `completed`.

4. **Document Learnings**
   If non-trivial problems were solved during implementation, suggest running `/skill:compound-docs` to capture the learnings.

## Key Principles

- **Start Fast, Execute Faster** — Get clarification once, then execute
- **The Plan is Your Guide** — Load referenced code and follow patterns
- **Test As You Go** — Don't wait until the end
- **Quality is Built In** — Follow patterns, write tests, lint
- **Ship Complete Features** — Don't leave features 80% done
