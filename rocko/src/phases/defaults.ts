import { join, dirname } from "path";

export const DEFAULT_PHASES: Record<string, string> = {
  "01-plan.md": `---
name: Plan
id: plan
initial: true

output:
  schema:
    type: object
    required:
      - task
      - approach
      - steps
      - estimatedComplexity
    properties:
      task:
        type: object
        required:
          - id
          - title
          - description
          - source
        properties:
          id:
            type: string
          title:
            type: string
          description:
            type: string
          source:
            type: string
      approach:
        type: string
      steps:
        type: array
        items:
          type: object
          properties:
            description:
              type: string
            files:
              type: array
              items:
                type: string
      estimatedComplexity:
        enum:
          - low
          - medium
          - high

transitions:
  - event: NOTHING_TO_DO
    target: end
    when: "tasks.length === 0"

  - event: START_BUILD
    target: build
    assign:
      plan: "response"
      task: "response.task"

ai:
  maxTurns: 5
---

## System Prompt

You are Rocko, an autonomous coding agent. Your job is to:
1. Analyze the available tasks and select the most appropriate one to work on
2. Create a detailed implementation plan for the selected task

When selecting a task, consider:
- Task priority (critical > high > medium > low)
- Task complexity and dependencies
- How well-defined the task requirements are

Your response MUST include a JSON block with this exact structure:
\`\`\`json
{
  "task": {
    "id": "task-id",
    "title": "Task title",
    "description": "Task description",
    "source": "source-identifier"
  },
  "approach": "High-level description of how you'll implement this",
  "steps": [
    {
      "description": "Step description",
      "files": ["file1.ts", "file2.ts"]
    }
  ],
  "estimatedComplexity": "low" | "medium" | "high"
}
\`\`\`

Be thorough in your planning. Consider:
- What files need to be created or modified
- What dependencies or imports are needed
- Edge cases and error handling
- Testing requirements

## User Prompt Template

## Available Tasks

{{#each tasks}}
{{@index}}. [{{id}}] {{title}}{{#if priority}} (Priority: {{priority}}){{/if}}
   Description: {{#if description}}{{description}}{{else}}No description provided{{/if}}
   Source: {{source}}
   {{#if labels}}Labels: {{#each labels}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}

{{/each}}

{{#if additionalContext}}
## Additional Context
{{additionalContext}}
{{/if}}

Please analyze these tasks and select the most appropriate one to work on. Then create a detailed implementation plan.

Remember to output your plan as a JSON block with the exact structure specified in your instructions.
`,

  "02-build.md": `---
name: Build
id: build

output:
  schema:
    type: object
    required:
      - filesChanged
      - summary
      - testsRun
      - testsPassed
    properties:
      filesChanged:
        type: array
        items:
          type: string
      summary:
        type: string
      testsRun:
        type: boolean
      testsPassed:
        type: boolean
      blocked:
        type: boolean
      blockReason:
        type: string

transitions:
  - event: BLOCKED
    target: plan
    when: "response.blocked === true"
    assign:
      error: "response.blockReason"

  - event: IMPLEMENTATION_DONE
    target: review
    assign:
      build: "response"

ai:
  maxTurns: 50
---

## System Prompt

You are Rocko, an autonomous coding agent in the BUILD phase. Your job is to implement the plan that was created in the previous phase.

You have full access to the codebase and can:
- Read and write files
- Run commands (tests, builds, etc.)
- Install dependencies if needed

Guidelines:
1. Follow the plan steps in order
2. Write clean, well-documented code
3. Handle edge cases and errors appropriately
4. Run tests after making changes
5. If you encounter a blocker that prevents implementation, report it

Your response MUST include a JSON block with this structure:
\`\`\`json
{
  "filesChanged": ["path/to/file1.ts", "path/to/file2.ts"],
  "summary": "Brief description of what was implemented",
  "testsRun": true,
  "testsPassed": true
}
\`\`\`

If you are blocked and cannot proceed:
\`\`\`json
{
  "filesChanged": [],
  "summary": "Could not complete implementation",
  "testsRun": false,
  "testsPassed": false,
  "blocked": true,
  "blockReason": "Description of why you're blocked"
}
\`\`\`

## User Prompt Template

## Current Task

**{{task.title}}**
{{task.description}}

## Implementation Plan

**Approach:** {{plan.approach}}

**Estimated Complexity:** {{plan.estimatedComplexity}}

### Steps

{{#each plan.steps}}
{{@index}}. {{description}}
   {{#if files}}Files: {{#each files}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}
{{/each}}

{{#if error}}
## Previous Error
The previous attempt encountered an error: {{error}}
Please address this in your implementation.
{{/if}}

Please implement this plan. Remember to:
1. Follow each step carefully
2. Write clean, well-documented code
3. Run tests after making changes
4. Report your changes as a JSON block
`,

  "03-review.md": `---
name: Review
id: review

output:
  schema:
    type: object
    required:
      - approved
      - issues
      - summary
    properties:
      approved:
        type: boolean
      issues:
        type: array
        items:
          type: object
          properties:
            severity:
              enum:
                - error
                - warning
                - suggestion
            file:
              type: string
            line:
              type: number
            message:
              type: string
            suggestion:
              type: string
      summary:
        type: string

transitions:
  - event: NEEDS_FIXES
    target: build
    when: "response.approved === false"
    assign:
      review: "response"

  - event: APPROVED
    target: commit
    assign:
      review: "response"

ai:
  maxTurns: 10
---

## System Prompt

You are Rocko, an autonomous coding agent in the REVIEW phase. Your job is to review the changes made in the build phase.

Review criteria:
1. **Correctness**: Does the code do what it's supposed to?
2. **Code Quality**: Is the code clean, readable, and maintainable?
3. **Edge Cases**: Are edge cases and errors handled?
4. **Tests**: Are there appropriate tests? Do they pass?
5. **Security**: Are there any security concerns?
6. **Performance**: Are there any obvious performance issues?

Your response MUST include a JSON block with this structure:
\`\`\`json
{
  "approved": true,
  "issues": [],
  "summary": "Changes look good. All tests pass."
}
\`\`\`

Or if there are issues:
\`\`\`json
{
  "approved": false,
  "issues": [
    {
      "severity": "error",
      "file": "src/example.ts",
      "line": 42,
      "message": "Missing null check",
      "suggestion": "Add null check before accessing property"
    }
  ],
  "summary": "Found 1 issue that needs to be fixed before approval."
}
\`\`\`

## User Prompt Template

## Task Completed

**{{task.title}}**

## Build Summary

{{build.summary}}

### Files Changed

{{#each build.filesChanged}}
- {{this}}
{{/each}}

### Test Results

- Tests Run: {{#if build.testsRun}}Yes{{else}}No{{/if}}
- Tests Passed: {{#if build.testsPassed}}Yes{{else}}No{{/if}}

Please review these changes against the original task requirements and implementation plan.

Approve if the changes are correct and complete, or list any issues that need to be fixed.
`,

  "04-commit.md": `---
name: Commit
id: commit

output:
  schema:
    type: object
    required:
      - type
      - description
    properties:
      type:
        enum:
          - feat
          - fix
          - chore
          - refactor
          - docs
          - test
          - style
      scope:
        type: string
      description:
        type: string
      body:
        type: string
      breaking:
        type: boolean

transitions:
  - event: COMMITTED
    target: end
    when: "context.iteration >= context.maxIterations"

  - event: NEXT_ITERATION
    target: plan
    when: "context.iteration < context.maxIterations"

  - event: COMMIT_FAILED
    target: review
    assign:
      error: "response.error"

ai:
  maxTurns: 3
---

## System Prompt

You are Rocko, an autonomous coding agent in the COMMIT phase. Your job is to create a proper conventional commit message for the changes made.

Follow the Conventional Commits specification:
- \`feat\`: A new feature
- \`fix\`: A bug fix
- \`chore\`: Maintenance tasks
- \`refactor\`: Code refactoring
- \`docs\`: Documentation changes
- \`test\`: Adding or updating tests
- \`style\`: Code style changes (formatting, etc.)

Your response MUST include a JSON block with this structure:
\`\`\`json
{
  "type": "feat",
  "scope": "optional-scope",
  "description": "short description of the change",
  "body": "optional longer description",
  "breaking": false
}
\`\`\`

## User Prompt Template

## Task Completed

**{{task.title}}**
{{task.description}}

## Changes Made

{{build.summary}}

### Files Changed

{{#each build.filesChanged}}
- {{this}}
{{/each}}

## Review Summary

{{review.summary}}

Please generate an appropriate conventional commit message for these changes.
`,

  "05-end.md": `---
name: End
id: end
final: true
---

## System Prompt

This is the final state. No action required.

## User Prompt Template

Workflow complete.
`,
};

/**
 * Create default phase files in the specified directory
 */
export async function createDefaultPhases(phasesDir: string): Promise<void> {
  // Ensure parent directory exists
  await Bun.$`mkdir -p ${phasesDir}`.quiet();

  // Write each default phase file
  for (const [filename, content] of Object.entries(DEFAULT_PHASES)) {
    const filePath = join(phasesDir, filename);
    await Bun.write(filePath, content);
  }
}

/**
 * Get list of default phase filenames
 */
export function getDefaultPhaseFilenames(): string[] {
  return Object.keys(DEFAULT_PHASES).sort();
}
