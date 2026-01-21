import { queryRaw } from "../claude/index.ts";
import type { PlanOutput, BuildOutput } from "../machine/types.ts";
import type { AIConfig } from "../config/schema.ts";
import { getStatus, getDiff } from "../git/index.ts";

const BUILD_SYSTEM_PROMPT = `You are Rocko, an autonomous coding agent in the BUILD phase.

Your job is to implement the plan that was created in the PLAN phase. You have access to:
- Read and write files
- Run terminal commands
- Search the codebase

Implementation Guidelines:
1. Follow the plan's steps in order
2. Write clean, well-documented code
3. Handle edge cases appropriately
4. Add necessary imports and dependencies
5. Run tests if applicable

When you're done implementing, provide a summary of what was changed.

IMPORTANT: Actually make the code changes. Don't just describe what should be done - DO IT.`;

function buildBuildPrompt(plan: PlanOutput, previousIssues?: string): string {
  let prompt = `## Implementation Plan

**Task:** ${plan.task.title}
**Description:** ${plan.task.description}

**Approach:** ${plan.approach}

**Steps to implement:**
${plan.steps.map((s, i) => `${i + 1}. ${s.description}\n   Files: ${s.files.join(", ")}`).join("\n")}

Please implement this plan now. Make all necessary code changes.`;

  if (previousIssues) {
    prompt += `\n\n## Previous Review Issues to Fix

The following issues were found in the previous review and need to be addressed:

${previousIssues}

Please fix these issues as part of your implementation.`;
  }

  prompt += `\n\nWhen done, summarize what files you changed and what was implemented.`;

  return prompt;
}

export async function runBuildPhase(
  plan: PlanOutput,
  aiConfig: AIConfig,
  previousIssues?: string,
  verbose = false
): Promise<{ type: "done"; output: BuildOutput } | { type: "blocked"; reason: string }> {
  const prompt = buildBuildPrompt(plan, previousIssues);

  try {
    const response = await queryRaw({
      prompt,
      systemPrompt: BUILD_SYSTEM_PROMPT,
      model: aiConfig.model,
      maxTurns: aiConfig.maxTurns,
      onMessage: (msg) => {
        if (verbose) {
          if (msg.type === "assistant") {
            console.log("[BUILD] Claude working...");
          }
        }
      },
    });

    const status = await getStatus();
    const diff = await getDiff();

    const changedFiles = [
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
    ];

    if (changedFiles.length === 0 && !diff) {
      return {
        type: "blocked",
        reason: "No files were changed during the build phase. The implementation may have failed.",
      };
    }

    const output: BuildOutput = {
      filesChanged: changedFiles,
      summary: response.content,
      testsRun: response.content.toLowerCase().includes("test"),
      testsPassed: !response.content.toLowerCase().includes("test failed") &&
        !response.content.toLowerCase().includes("tests failed"),
    };

    return { type: "done", output };
  } catch (error) {
    return {
      type: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
