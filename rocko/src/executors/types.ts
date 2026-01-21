import type { PhaseConfig, PhaseExecutionContext } from "../phases/schema.ts";
import type { AIConfig } from "../config/schema.ts";
import { z } from "zod";

// Executor type enum
export const ExecutorTypeSchema = z.enum(["direct", "acp"]);
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>;

// Direct executor (current, backward compatible default)
export const DirectExecutorConfigSchema = z.object({
  type: z.literal("direct"),
});
export type DirectExecutorConfig = z.infer<typeof DirectExecutorConfigSchema>;

// ACP executor - supports any ACP-compatible agent (Claude Code, Gemini, Codex, etc.)
export const ACPExecutorConfigSchema = z.object({
  type: z.literal("acp"),
  transport: z.enum(["stdio", "http", "websocket"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
});
export type ACPExecutorConfig = z.infer<typeof ACPExecutorConfigSchema>;

// Discriminated union of all executor configs
export const ExecutorConfigSchema = z.discriminatedUnion("type", [
  DirectExecutorConfigSchema,
  ACPExecutorConfigSchema,
]);
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;

// Tool call record for logging
export interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: unknown;
  duration?: number;
}

// Streaming callback for real-time output
export type StreamCallback = (delta: string) => void;

// Context passed to executor
export interface ExecutorContext {
  phase: PhaseConfig;
  executionContext: PhaseExecutionContext;
  aiConfig: AIConfig;
  verbose: boolean;
  onStream?: StreamCallback;
}

// Response from executor
export interface ExecutorResponse {
  content: string;
  parsedResponse?: unknown;
  toolCalls?: ToolCallRecord[];
  usage?: { inputTokens: number; outputTokens: number };
}

// Executor interface
export interface Executor {
  name: string;
  type: ExecutorType;
  initialize(config: ExecutorConfig): Promise<void>;
  execute(context: ExecutorContext): Promise<ExecutorResponse>;
  cleanup(): Promise<void>;
}

// Factory function type
export type ExecutorFactory = (config: ExecutorConfig) => Promise<Executor>;
