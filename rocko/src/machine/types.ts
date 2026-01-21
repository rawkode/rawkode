import type { Task } from "../adapter/types.ts";

export type Phase = "plan" | "build" | "review" | "commit" | "end";

export type MachineEvent =
  | { type: "START_BUILD"; plan: PlanOutput }
  | { type: "NOTHING_TO_DO" }
  | { type: "BLOCKED"; reason: string }
  | { type: "IMPLEMENTATION_DONE"; output: BuildOutput }
  | { type: "NEEDS_FIXES"; issues: ReviewIssue[] }
  | { type: "APPROVED" }
  | { type: "COMMITTED"; message: string }
  | { type: "COMMIT_FAILED"; reason: string }
  | { type: "NEXT_ITERATION" };

export interface PlanOutput {
  task: Task;
  approach: string;
  steps: PlanStep[];
  estimatedComplexity: "low" | "medium" | "high";
}

export interface PlanStep {
  description: string;
  files: string[];
}

export interface BuildOutput {
  filesChanged: string[];
  summary: string;
  testsRun: boolean;
  testsPassed: boolean;
}

export interface ReviewIssue {
  severity: "error" | "warning" | "suggestion";
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewOutput {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface CommitOutput {
  type: "feat" | "fix" | "chore" | "refactor" | "docs" | "test" | "style";
  scope?: string;
  description: string;
  body?: string;
  breaking?: boolean;
}

export interface MachineContext {
  iteration: number;
  maxIterations: number;
  currentPhase: Phase;
  task?: Task;
  plan?: PlanOutput;
  build?: BuildOutput;
  review?: ReviewOutput;
  commit?: CommitOutput;
  history: PhaseHistory[];
  error?: string;
}

export interface PhaseHistory {
  phase: Phase;
  timestamp: Date;
  event: string;
  data?: unknown;
}
