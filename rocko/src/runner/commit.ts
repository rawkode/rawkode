import { queryRaw, extractJSON } from "../claude/index.ts";
import type { BuildOutput, CommitOutput, PlanOutput } from "../machine/types.ts";
import type { AIConfig, GitConfig } from "../config/schema.ts";
import {
  stageAll,
  commit as gitCommit,
  getDiff,
  formatConventionalCommit,
  type GitCommitResult,
} from "../git/index.ts";

const COMMIT_SYSTEM_PROMPT = `You are Rocko, an autonomous coding agent in the COMMIT phase.

Your job is to analyze the code changes and generate an appropriate conventional commit message.

Conventional commit types:
- feat: A new feature
- fix: A bug fix
- docs: Documentation changes
- style: Code style changes (formatting, semicolons, etc.)
- refactor: Code refactoring without feature changes
- test: Adding or modifying tests
- chore: Maintenance tasks, dependency updates, etc.

Your response MUST include a JSON block with this exact structure:
\`\`\`json
{
  "type": "feat" | "fix" | "chore" | "refactor" | "docs" | "test" | "style",
  "scope": "optional-scope",
  "description": "Short description (imperative mood, no period)",
  "body": "Optional longer description",
  "breaking": false
}
\`\`\`

Guidelines:
- description should be concise (50 chars or less)
- Use imperative mood ("add feature" not "added feature")
- scope is optional but helpful (e.g., "auth", "api", "ui")
- body is optional, use for complex changes
- breaking: true only for backwards-incompatible changes`;

function buildCommitPrompt(plan: PlanOutput, build: BuildOutput): string {
  return `## Task Completed

**Task:** ${plan.task.title}
**Description:** ${plan.task.description}

## Changes Made

**Files Changed:** ${build.filesChanged.join(", ")}

**Implementation Summary:**
${build.summary}

Please analyze these changes and generate an appropriate conventional commit message.

Output your commit message as a JSON block with the structure specified in your instructions.`;
}

export async function runCommitPhase(
  plan: PlanOutput,
  build: BuildOutput,
  aiConfig: AIConfig,
  gitConfig: GitConfig,
  verbose = false
): Promise<
  | { type: "committed"; message: string; result: GitCommitResult }
  | { type: "failed"; reason: string }
> {
  const prompt = buildCommitPrompt(plan, build);

  try {
    const response = await queryRaw({
      prompt,
      systemPrompt: COMMIT_SYSTEM_PROMPT,
      model: aiConfig.model,
      maxTurns: 3,
      onMessage: (msg) => {
        if (verbose && msg.type === "assistant") {
          console.log("[COMMIT] Generating commit message...");
        }
      },
    });

    const rawCommit = extractJSON<CommitOutput>(response.content);

    if (!rawCommit) {
      return {
        type: "failed",
        reason: "Failed to generate commit message from Claude response",
      };
    }

    const commitOutput: CommitOutput = {
      type: rawCommit.type,
      scope: rawCommit.scope,
      description: rawCommit.description,
      body: rawCommit.body,
      breaking: rawCommit.breaking,
    };

    let message = formatConventionalCommit(
      commitOutput.type,
      commitOutput.scope,
      commitOutput.description,
      commitOutput.body,
      commitOutput.breaking
    );

    if (gitConfig.commitPrefix) {
      message = `${gitConfig.commitPrefix} ${message}`;
    }

    await stageAll();
    const result = await gitCommit(message);

    return {
      type: "committed",
      message,
      result,
    };
  } catch (error) {
    return {
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function generateCommitMessage(
  plan: PlanOutput,
  build: BuildOutput,
  aiConfig: AIConfig
): Promise<CommitOutput | null> {
  const prompt = buildCommitPrompt(plan, build);

  const response = await queryRaw({
    prompt,
    systemPrompt: COMMIT_SYSTEM_PROMPT,
    model: aiConfig.model,
    maxTurns: 3,
  });

  return extractJSON<CommitOutput>(response.content);
}
