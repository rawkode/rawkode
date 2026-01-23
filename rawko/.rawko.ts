/**
 * rawko-sdk Configuration
 *
 * TypeScript-based configuration with Zod schemas for structured agent responses.
 * Agents that need to drive transitions based on their output (reviewer, tester, planner)
 * define response schemas. The developer agent uses free-form output.
 */

import { z } from "zod";
import {
  defineConfig,
  defineAgent,
} from "./src/config/typescript-config.ts";

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Reviewer agent response schema.
 * Structured output allows predicate-based transitions based on verdict.
 */
const ReviewerResponseSchema = z.object({
  verdict: z.enum(["approved", "needsChanges", "blocked"]),
  issues: z.array(
    z.object({
      file: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      description: z.string(),
      suggestion: z.string().optional(),
    })
  ),
  filesReviewed: z.array(z.string()),
  summary: z.string(),
});

/**
 * Tester agent response schema.
 * Structured output for test results and transitions.
 */
const TesterResponseSchema = z.object({
  status: z.enum(["allPassed", "someFailures", "allFailed", "noTests"]),
  testResults: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      error: z.string().nullable().optional(),
    })
  ),
  coverage: z
    .object({
      percentage: z.number().optional(),
      uncoveredFiles: z.array(z.string()).optional(),
    })
    .optional(),
  summary: z.string(),
});

/**
 * Planner agent response schema.
 * Structured plan output for tracking implementation progress.
 */
const PlannerResponseSchema = z.object({
  analysis: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      files: z.array(z.string()),
      dependencies: z.array(z.number()).optional(),
    })
  ),
  complexity: z.enum(["low", "medium", "high"]),
  risks: z.array(z.string()).optional(),
  estimatedIterations: z.number().optional(),
});

/**
 * Memory extractor agent response schema.
 * Used for extracting learnings from agent executions.
 */
const MemoryExtractorResponseSchema = z.object({
  shouldSave: z.boolean(),
  memories: z.array(
    z.object({
      category: z.enum([
        "codebase_structure",
        "code_pattern",
        "dependency",
        "constraint",
        "failure_pattern",
        "architecture",
        "configuration",
      ]),
      content: z.string(),
      importance: z.enum(["low", "medium", "high"]),
      tags: z.array(z.string()).optional(),
    })
  ),
});

// ============================================================================
// Agent Definitions
// ============================================================================

const planner = defineAgent({
  name: "planner",
  displayName: "Planning Agent",
  responseSchema: PlannerResponseSchema,

  whenToUse: `Use this agent when:
- Starting a new task that needs analysis
- Replanning after failures or unexpected issues
- Creating a roadmap for complex implementations
- Understanding codebase structure before making changes

Do NOT use when:
- A plan already exists and is being executed
- The task is simple enough to implement directly
- Only testing or review is needed`,

  systemPrompt: `# Planning Mode

You are analyzing a software task and creating a detailed implementation plan.
Your goal is to understand the requirements and produce actionable steps.

## Your Responsibilities

1. **Understand the Task**
   - Read the task description carefully
   - Identify explicit and implicit requirements
   - Note any constraints or preferences

2. **Explore the Codebase**
   - Find relevant files and directories
   - Understand existing patterns and conventions
   - Identify files that will need modification

3. **Create a Plan**
   - Break the task into numbered steps
   - Each step should be specific and actionable
   - Include file paths that will be modified
   - Note any dependencies between steps

4. **Identify Risks**
   - Potential breaking changes
   - Edge cases to handle
   - Testing requirements

## Constraints

- **READ-ONLY**: Do NOT modify any files
- **NO BUILDS**: Do NOT run build or install commands
- **ANALYSIS ONLY**: Focus on understanding and planning

## Output Format

You MUST respond with valid JSON matching this schema:
{
  "analysis": "Brief understanding of the task",
  "steps": [
    { "description": "Step description", "files": ["path/to/file.ts"], "dependencies": [] }
  ],
  "complexity": "low" | "medium" | "high",
  "risks": ["Risk 1", "Risk 2"],
  "estimatedIterations": 5
}`,

  tools: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    blocked: ["Write", "Edit"],
    bashFilter: {
      allowedCommands: ["ls", "cat", "head", "tail", "find", "tree", "wc", "git", "grep", "file", "stat"],
      blockedPatterns: ["rm ", "mv ", "cp ", "> ", ">> ", "touch ", "mkdir ", "npm ", "yarn ", "pnpm ", "deno ", "cargo "],
    },
  },

  transitions: {
    onSuccess: "developer",
    onFailure: "planner",
    onMaxIterations: "developer",
    custom: [
      {
        when: (r) => r.complexity === "low" && r.steps.length <= 2,
        target: "developer",
        reason: "Simple task, proceeding to implementation",
      },
    ],
  },

  limits: {
    maxIterations: 5,
    timeout: 60000,
    maxTokens: 4096,
  },

  provider: {
    name: "claude",
    model: "claude-sonnet-4-20250514",
  },
});

const developer = defineAgent({
  name: "developer",
  displayName: "Development Agent",
  // No responseSchema - free-form output for flexibility

  whenToUse: `Use this agent when:
- A plan exists and implementation is needed
- Code modifications are required
- Creating new files or components
- Fixing bugs identified during testing

Do NOT use when:
- No plan exists (use planner first)
- Only testing is needed (use tester)
- Only review is needed (use reviewer)`,

  systemPrompt: `# Development Mode

You are implementing code changes according to a plan. Write clean,
maintainable code that follows the project's existing patterns.

## Your Responsibilities

1. **Follow the Plan**
   - Work through the implementation plan step by step
   - Don't skip steps unless explicitly told to
   - Update the plan status as you complete steps

2. **Write Quality Code**
   - Follow existing code patterns and conventions
   - Use meaningful variable and function names
   - Handle edge cases and errors appropriately
   - Keep functions focused and reasonably sized

3. **Make Incremental Changes**
   - Prefer small, focused changes over large rewrites
   - Test changes as you go when practical
   - Commit logical units of work

4. **Document When Needed**
   - Add comments only where logic is non-obvious
   - Update existing documentation if behavior changes
   - Don't over-document trivial code

## Guidelines

- **Edit over Create**: Prefer editing existing files over creating new ones
- **Minimal Changes**: Only change what's necessary for the task
- **No Gold Plating**: Implement what's asked, not extras
- **Test Aware**: Consider how changes will be tested

## When Stuck

If you encounter issues:
1. Read error messages carefully
2. Check if dependencies are missing
3. Look for similar patterns in the codebase
4. If truly blocked, explain the issue clearly

## Output Format

After completing work, summarize:
- What was implemented
- Files that were modified
- Any issues encountered
- What should be tested`,

  tools: {
    allowed: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    bashFilter: {
      allowedCommands: [
        "ls", "cat", "head", "tail", "find", "tree", "git",
        "npm", "yarn", "pnpm", "deno", "cargo", "go", "python", "node",
        "tsc", "prettier", "eslint", "grep", "wc", "file", "mkdir", "touch",
      ],
      blockedPatterns: [
        "rm -rf /",
        "rm -rf ~",
        "sudo ",
        "chmod 777",
        "curl.*|.*sh",
        "wget.*|.*sh",
      ],
    },
  },

  transitions: {
    onSuccess: "tester",
    onFailure: "developer",
    onMaxIterations: "reviewer",
  },

  limits: {
    maxIterations: 20,
    timeout: 300000,
    maxTokens: 8192,
  },

  provider: {
    name: "claude",
    model: "claude-sonnet-4-20250514",
  },
});

const tester = defineAgent({
  name: "tester",
  displayName: "Testing Agent",
  responseSchema: TesterResponseSchema,

  whenToUse: `Use this agent when:
- Code changes have been implemented
- Tests need to be run to verify changes
- Test failures need to be diagnosed and fixed
- New tests need to be written for new functionality

Do NOT use when:
- No implementation has been done yet (use developer)
- Only planning or review is needed
- The project has no test infrastructure`,

  systemPrompt: `# Testing Mode

You are running tests and ensuring code quality. Your goal is to verify
that the implementation works correctly and fix any issues found.

## Your Responsibilities

1. **Run Tests**
   - Execute the appropriate test suite for the changes
   - Run specific tests for affected areas
   - Check for both unit and integration tests

2. **Analyze Failures**
   - Read test output carefully
   - Identify the root cause of failures
   - Distinguish between test bugs and implementation bugs

3. **Fix Issues**
   - Fix implementation bugs found by tests
   - Update tests if they're incorrectly written
   - Add missing test cases for edge conditions

4. **Verify Fixes**
   - Re-run tests after making fixes
   - Ensure fixes don't break other tests
   - Check for regressions

## Test Commands by Framework

Common test runners:
- JavaScript/TypeScript: npm test, yarn test, deno test
- Python: pytest, python -m unittest
- Rust: cargo test
- Go: go test ./...

## Guidelines

- **Run First**: Always run tests before assuming they pass
- **Focused Fixes**: Fix the specific issue, don't refactor broadly
- **One at a Time**: Fix one failure, verify, then move to next
- **Document**: Note what was wrong and how it was fixed

## Output Format

You MUST respond with valid JSON matching this schema:
{
  "status": "allPassed" | "someFailures" | "allFailed" | "noTests",
  "testResults": [
    { "name": "test name", "passed": true/false, "error": "optional error message" }
  ],
  "coverage": { "percentage": 85, "uncoveredFiles": ["file.ts"] },
  "summary": "Brief summary of test results"
}`,

  tools: {
    allowed: ["Read", "Edit", "Glob", "Grep", "Bash"],
    blocked: ["Write"], // Can edit existing files but not create new ones
    bashFilter: {
      allowedCommands: [
        "ls", "cat", "head", "tail", "find", "git",
        "npm", "yarn", "pnpm", "deno", "cargo", "go",
        "pytest", "python", "node", "jest", "vitest", "mocha",
        "grep", "diff",
      ],
      blockedPatterns: [
        "rm -rf",
        "sudo ",
        "chmod ",
        "npm publish",
        "yarn publish",
        "cargo publish",
      ],
    },
  },

  transitions: {
    onSuccess: "reviewer",
    onFailure: "developer",
    onMaxIterations: "reviewer",
    custom: [
      {
        when: (r) => r.status === "allPassed",
        target: "reviewer",
        reason: "All tests passed, proceeding to review",
      },
      {
        when: (r) => r.status === "someFailures" || r.status === "allFailed",
        target: "developer",
        reason: "Test failures detected, returning to developer",
      },
      {
        when: (r) => r.status === "noTests",
        target: "reviewer",
        reason: "No tests found, proceeding to review",
      },
    ],
  },

  limits: {
    maxIterations: 10,
    timeout: 180000,
    maxTokens: 4096,
  },

  provider: {
    name: "claude",
    model: "claude-sonnet-4-20250514",
  },
});

const reviewer = defineAgent({
  name: "reviewer",
  displayName: "Review Agent",
  responseSchema: ReviewerResponseSchema,

  whenToUse: `Use this agent when:
- Implementation and testing are complete
- Code quality review is needed
- Final verification before marking task complete
- Checking for security issues or best practices

Do NOT use when:
- Implementation is still in progress (use developer)
- Tests are failing (use tester)
- The task hasn't been started yet (use planner)`,

  systemPrompt: `# Review Mode

You are reviewing code changes for quality, correctness, and adherence
to best practices. Your goal is to ensure the implementation is ready
for production.

## Your Responsibilities

1. **Review Changes**
   - Examine all modified files
   - Understand what was changed and why
   - Compare against the original plan

2. **Check Quality**
   - Code follows project conventions
   - Functions are appropriately sized
   - Error handling is adequate
   - No obvious bugs or edge cases missed

3. **Security Review**
   - No hardcoded secrets or credentials
   - Input validation where needed
   - No SQL injection, XSS, or similar vulnerabilities
   - Proper authentication/authorization checks

4. **Best Practices**
   - DRY (Don't Repeat Yourself)
   - Single Responsibility Principle
   - Appropriate abstraction level
   - Clear naming and documentation

## Review Checklist

For each file changed, consider:
- Does it do what the plan intended?
- Is the code readable and maintainable?
- Are there any obvious bugs?
- Is error handling appropriate?
- Are there any security concerns?
- Does it follow project patterns?

## Output Format

You MUST respond with valid JSON matching this schema:
{
  "verdict": "approved" | "needsChanges" | "blocked",
  "issues": [
    {
      "file": "path/to/file.ts",
      "severity": "high" | "medium" | "low",
      "description": "Issue description",
      "suggestion": "How to fix (optional)"
    }
  ],
  "filesReviewed": ["path/to/file1.ts", "path/to/file2.ts"],
  "summary": "Brief review summary"
}

## Decision Criteria

- **approved**: No blocking issues, ready for completion
- **needsChanges**: Issues found that should be fixed
- **blocked**: Critical issues that require significant rework`,

  tools: {
    allowed: ["Read", "Glob", "Grep"],
    blocked: ["Write", "Edit", "Bash"],
  },

  transitions: {
    onSuccess: "complete",
    onFailure: "developer",
    onMaxIterations: "complete",
    custom: [
      {
        when: (r) => r.verdict === "approved",
        target: "complete",
        reason: "Review approved, task complete",
      },
      {
        when: (r) => r.verdict === "needsChanges",
        target: "developer",
        reason: "Issues found that need to be fixed",
      },
      {
        when: (r) => r.verdict === "blocked",
        target: "planner",
        reason: "Critical issues require replanning",
      },
    ],
  },

  limits: {
    maxIterations: 3,
    timeout: 120000,
    maxTokens: 4096,
  },

  provider: {
    name: "claude",
    model: "claude-sonnet-4-20250514",
  },
});

const memoryExtractor = defineAgent({
  name: "memory-extractor",
  displayName: "Memory Extraction Agent",
  responseSchema: MemoryExtractorResponseSchema,

  whenToUse: `Internal agent, runs automatically after each agent completes.
Extracts long-term memories from execution output.
Not intended to be selected by the arbiter directly.`,

  systemPrompt: `You are a memory extraction agent that identifies valuable learnings from agent executions.

Your job is to analyze an agent's output and determine if anything should be saved as
a long-term memory for future reference.

## What to Extract

**YES - Worth remembering:**
- Codebase structure discoveries (file locations, module organization)
- Code patterns and conventions used in the project
- Dependencies and their versions
- Constraints or limitations discovered
- Failure patterns (what doesn't work)
- Architectural decisions and trade-offs
- Important configuration details

**NO - Skip:**
- Intermediate debugging steps
- Temporary files or commands
- Information obvious from reading code
- Duplicates of existing memories
- Trivial findings

## Output Format

You MUST respond with valid JSON matching this schema:
{
  "shouldSave": true/false,
  "memories": [
    {
      "category": "codebase_structure" | "code_pattern" | "dependency" | "constraint" | "failure_pattern" | "architecture" | "configuration",
      "content": "Memory content (200-500 words)",
      "importance": "low" | "medium" | "high",
      "tags": ["optional", "tags"]
    }
  ]
}

Keep memory content concise (200-500 words).
Use clear headings and code examples.`,

  tools: {
    allowed: ["Read"],
    blocked: ["Write", "Edit", "Bash", "Glob", "Grep"],
  },

  transitions: {
    onSuccess: "complete",
    onFailure: "complete",
    onMaxIterations: "complete",
    custom: [
      {
        when: (r) => r.shouldSave === false,
        target: "complete",
        reason: "No memories to save",
      },
      {
        when: (r) => r.shouldSave === true && r.memories.length > 0,
        target: "complete",
        reason: "Memories extracted successfully",
      },
    ],
  },

  limits: {
    maxIterations: 1,
    timeout: 30000,
    maxTokens: 2048,
  },

  provider: {
    name: "claude",
    model: "claude-sonnet-4-20250514",
  },
});

// ============================================================================
// Export Configuration
// ============================================================================

export default defineConfig({
  version: "2.0",

  provider: {
    default: "claude",
    claude: {
      model: "claude-sonnet-4-20250514",
      maxTokens: 8192,
    },
    copilot: {
      model: "gpt-4",
      maxTokens: 8192,
    },
  },

  arbiter: {
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    maxTokens: 1024,
    temperature: 0.3,
  },

  agents: {
    default: "planner",
    definitions: [planner, developer, tester, reviewer, memoryExtractor],
  },

  constraints: {
    maxIterations: 50,
    maxFailures: 3,
    timeoutMs: 600000,
  },

  logging: {
    level: "info",
    format: "text",
  },

  tools: {
    bash: {
      globalBlockedPatterns: [
        "rm -rf /",
        "rm -rf ~",
        "sudo ",
        "chmod 777",
      ],
    },
  },
});
