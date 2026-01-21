import { queryRaw, extractJSON } from "../claude/index.ts";
import type { BuildOutput, ReviewOutput, ReviewIssue } from "../machine/types.ts";
import type { AIConfig } from "../config/schema.ts";
import { getDiff } from "../git/index.ts";

const REVIEW_SYSTEM_PROMPT = `You are Rocko, an autonomous coding agent in the REVIEW phase.

Your job is to review the code changes made in the BUILD phase and determine if they:
1. Correctly implement the requirements
2. Follow best practices
3. Don't introduce bugs or security issues
4. Are properly tested

Be thorough but practical. Focus on:
- Logic errors and bugs
- Security vulnerabilities
- Missing error handling
- Code quality issues
- Test coverage

Your response MUST include a JSON block with this exact structure:
\`\`\`json
{
  "approved": true/false,
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "summary": "Overall assessment of the changes"
}
\`\`\`

Rules:
- "error" severity issues MUST be fixed (approved = false)
- "warning" issues SHOULD be fixed but can be approved
- "suggestion" issues are nice-to-have improvements

If there are no blocking issues, set approved to true.`;

function buildReviewPrompt(build: BuildOutput): string {
  return `## Build Summary

**Files Changed:** ${build.filesChanged.join(", ")}
**Tests Run:** ${build.testsRun ? "Yes" : "No"}
**Tests Passed:** ${build.testsPassed ? "Yes" : "No"}

**Implementation Summary:**
${build.summary}

Please review these changes and provide your assessment. Look at the actual git diff and file contents to evaluate the implementation.

Output your review as a JSON block with the structure specified in your instructions.`;
}

export async function runReviewPhase(
  build: BuildOutput,
  aiConfig: AIConfig,
  verbose = false
): Promise<{ type: "approved"; output: ReviewOutput } | { type: "needs_fixes"; issues: ReviewIssue[] }> {
  const prompt = buildReviewPrompt(build);

  const response = await queryRaw({
    prompt,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: aiConfig.model,
    maxTurns: 10,
    onMessage: (msg) => {
      if (verbose && msg.type === "assistant") {
        console.log("[REVIEW] Claude reviewing...");
      }
    },
  });

  const rawReview = extractJSON<ReviewOutput>(response.content);

  if (!rawReview) {
    return {
      type: "approved",
      output: {
        approved: true,
        issues: [],
        summary: "Review completed - unable to parse structured output, assuming approved.",
      },
    };
  }

  const review: ReviewOutput = {
    approved: rawReview.approved,
    issues: rawReview.issues || [],
    summary: rawReview.summary || "Review completed.",
  };

  const errors = review.issues.filter((i) => i.severity === "error");

  if (errors.length > 0 || !review.approved) {
    return {
      type: "needs_fixes",
      issues: review.issues,
    };
  }

  return {
    type: "approved",
    output: review,
  };
}

export function formatIssuesForBuild(issues: ReviewIssue[]): string {
  return issues
    .map((issue) => {
      let line = `- [${issue.severity.toUpperCase()}] ${issue.file}`;
      if (issue.line) {
        line += `:${issue.line}`;
      }
      line += `\n  ${issue.message}`;
      if (issue.suggestion) {
        line += `\n  Suggestion: ${issue.suggestion}`;
      }
      return line;
    })
    .join("\n\n");
}
