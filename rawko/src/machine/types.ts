/**
 * XState machine types for rawko-sdk
 */

import type { AgentConfig, ProviderConfig } from "../config/types.ts";
import type { ProviderSession, Message, ToolCall, TokenUsage } from "../providers/types.ts";
import type { ToolResult } from "../tools/types.ts";
import type { ArbiterDecision, Plan, ExecutionEntry } from "../arbiter/types.ts";

/**
 * Complete context type for the rawko state machine.
 */
export interface RawkoContext {
  task: string;
  startedAt: Date | null;
  currentAgent: AgentConfig | null;
  currentMode: string;
  agents: Map<string, AgentConfig>;
  plan: Plan | null;
  history: ExecutionEntry[];
  messages: Message[];
  consecutiveFailures: number;
  totalFailures: number;
  lastError: Error | null;
  currentSession: ProviderSession | null;
  currentProviderName: string | null;
  providerConfig: ProviderConfig;
  lastArbiterDecision: ArbiterDecision | null;
  maxIterations: number;
  iterationCount: number;
  maxFailures: number;
  defaultAgent: string;
}

/**
 * Result of an agent execution.
 */
export interface AgentResult {
  success: boolean;
  output: string;
  planUpdates?: Partial<Plan>;
  usage?: TokenUsage;
  messages?: Message[];
}

/**
 * All events the rawko machine can receive.
 */
export type RawkoEvent =
  | { type: "START_TASK"; task: string }
  | { type: "CANCEL" }
  | { type: "RESET" }
  | { type: "AGENT_SELECTED"; agent: AgentConfig }
  | { type: "AGENT_SELECTION_FAILED"; error: Error }
  | { type: "AGENT_MESSAGE"; message: Message }
  | { type: "AGENT_TOOL_CALL"; toolCall: ToolCall }
  | { type: "AGENT_TOOL_RESULT"; toolResult: ToolResult }
  | { type: "AGENT_COMPLETE"; result: AgentResult }
  | { type: "AGENT_ERROR"; error: Error }
  | { type: "ARBITER_DECISION"; decision: ArbiterDecision }
  | { type: "ARBITER_ERROR"; error: Error }
  | { type: "FORCE_AGENT"; agentName: string }
  | { type: "SKIP_STEP" }
  | { type: "RETRY" };

/**
 * Input for creating the machine context.
 */
export interface RawkoMachineInput {
  agents?: Map<string, AgentConfig>;
  providerConfig?: ProviderConfig;
  maxIterations?: number;
  maxFailures?: number;
  defaultAgent?: string;
}
