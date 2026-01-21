// Rocko - A portable, extensible PLAN → BUILD → REVIEW agent
// Main library exports

// Config
export { defineConfig, loadConfig, findConfig, CONFIG_TEMPLATE, GITHUB_CONFIG_TEMPLATE } from "./config/index.ts";
export type {
  RockoConfig,
  AdapterConfig,
  MarkdownAdapterConfig,
  GitHubAdapterConfig,
  GitConfig,
  GitHubConfig,
  AIConfig,
} from "./config/schema.ts";

// State Machine
export { rockoMachine } from "./machine/index.ts";
export type {
  Phase,
  MachineEvent,
  MachineContext,
  PlanOutput,
  PlanStep,
  BuildOutput,
  ReviewOutput,
  ReviewIssue,
  CommitOutput,
  PhaseHistory,
} from "./machine/types.ts";

// Schemas
export {
  TaskSchema,
  PlanStepSchema,
  PlanOutputSchema,
  BuildOutputSchema,
  ReviewIssueSchema,
  ReviewOutputSchema,
  CommitOutputSchema,
} from "./machine/schemas.ts";

// State Persistence
export { readState, writeState, clearState, stateToContext } from "./state/index.ts";
export type { RockoState, StateOptions } from "./state/types.ts";

// Adapters
export { registerAdapter, createAdapter, loadBuiltinAdapters } from "./adapter/registry.ts";
export type { Adapter, AdapterContext, AdapterHooks, Task, TaskUpdate } from "./adapter/types.ts";
export { createMarkdownAdapter } from "./markdown/adapter.ts";
export { createGitHubAdapter } from "./github/adapter.ts";
export { GitHubClient } from "./github/client.ts";
export type { GitHubIssue, GitHubComment, GitHubClientConfig } from "./github/client.ts";

// Git Operations
export {
  getGitRoot,
  isGitRepo,
  getCurrentBranch,
  getStatus,
  getDiff,
  getDiffFiles,
  stageAll,
  stageFiles,
  commit,
  getRecentCommits,
  getChangedFilesSinceCommit,
  formatConventionalCommit,
} from "./git/index.ts";
export type { GitStatus, GitCommitResult, GitDiffFile } from "./git/index.ts";

// Claude Integration
export { queryRaw, queryWithParsing, extractJSON, createClaudeConfig } from "./claude/index.ts";
export type { ClaudeResponse, ClaudeQueryOptions } from "./claude/index.ts";

// Runner
export { run } from "./runner/index.ts";
export type { RunnerOptions, RunnerResult } from "./runner/index.ts";
export { runPlanPhase, selectTaskForPlan } from "./runner/plan.ts";
export { runBuildPhase } from "./runner/build.ts";
export { runReviewPhase, formatIssuesForBuild } from "./runner/review.ts";
export { runCommitPhase, generateCommitMessage } from "./runner/commit.ts";
