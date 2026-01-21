import { z } from "zod";

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  source: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const PlanStepSchema = z.object({
  description: z.string(),
  files: z.array(z.string()),
});

export const PlanOutputSchema = z.object({
  task: TaskSchema,
  approach: z.string(),
  steps: z.array(PlanStepSchema),
  estimatedComplexity: z.enum(["low", "medium", "high"]),
});

export const BuildOutputSchema = z.object({
  filesChanged: z.array(z.string()),
  summary: z.string(),
  testsRun: z.boolean(),
  testsPassed: z.boolean(),
});

export const ReviewIssueSchema = z.object({
  severity: z.enum(["error", "warning", "suggestion"]),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const ReviewOutputSchema = z.object({
  approved: z.boolean(),
  issues: z.array(ReviewIssueSchema),
  summary: z.string(),
});

export const CommitOutputSchema = z.object({
  type: z.enum(["feat", "fix", "chore", "refactor", "docs", "test", "style"]),
  scope: z.string().optional(),
  description: z.string(),
  body: z.string().optional(),
  breaking: z.boolean().optional(),
});
