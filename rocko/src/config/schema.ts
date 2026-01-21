import { z } from "zod";

export const MarkdownAdapterConfigSchema = z.object({
  type: z.literal("markdown"),
  path: z.string().default("TASKS.md"),
  watchChanges: z.boolean().default(false),
});

export const GitHubAdapterConfigSchema = z.object({
  type: z.literal("github-issues"),
  owner: z.string(),
  repo: z.string(),
  labels: z.array(z.string()).default(["rocko"]),
  aiSelectsIssue: z.boolean().default(true),
  excludeLabels: z.array(z.string()).optional(),
});

export const AdapterConfigSchema = z.discriminatedUnion("type", [
  MarkdownAdapterConfigSchema,
  GitHubAdapterConfigSchema,
]);

export const GitConfigSchema = z.object({
  autoCommit: z.boolean().default(true),
  commitPrefix: z.string().default("rocko:"),
  signCommits: z.boolean().default(false),
});

export const GitHubConfigSchema = z.object({
  addComments: z.boolean().default(true),
  updateLabels: z.boolean().default(true),
  closeOnComplete: z.boolean().default(true),
  inProgressLabel: z.string().default("in-progress"),
  completedLabel: z.string().default("completed"),
});

export const AIConfigSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  maxTurns: z.number().default(20),
});

export const RockoConfigSchema = z.object({
  adapter: AdapterConfigSchema,
  maxIterations: z.number().default(5),
  git: GitConfigSchema.default({}),
  github: GitHubConfigSchema.default({}),
  ai: AIConfigSchema.default({}),
  verbose: z.boolean().default(false),
});

export type MarkdownAdapterConfig = z.infer<typeof MarkdownAdapterConfigSchema>;
export type GitHubAdapterConfig = z.infer<typeof GitHubAdapterConfigSchema>;
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;
export type GitConfig = z.infer<typeof GitConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type RockoConfig = z.infer<typeof RockoConfigSchema>;
