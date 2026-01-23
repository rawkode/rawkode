/**
 * Invoked actors for the rawko state machine
 */

import { fromPromise, fromCallback } from "xstate";
import type { AgentConfig, ArbiterConfig, ProviderConfig } from "../config/types.ts";
import type { ProviderSession } from "../providers/types.ts";
import { ProviderFactory } from "../providers/factory.ts";
import { Arbiter } from "../arbiter/arbiter.ts";
import type { ArbiterDecision, Plan, ExecutionEntry } from "../arbiter/types.ts";
import {
  constructSelectAgentInput,
  constructEvaluateProgressInput,
  type MachineContextSnapshot,
} from "../arbiter/context.ts";
import { AgentExecutor } from "../executor/executor.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { RawkoContext, AgentResult } from "./types.ts";

interface CreateAgentSessionInput {
  agent: AgentConfig;
  providerConfig: ProviderConfig;
}

interface CreateAgentSessionOutput {
  session: ProviderSession;
  providerName: string;
  usedFallback: boolean;
}

/**
 * Helper to get the provider name for an agent.
 * Uses agent-specific provider if configured, otherwise falls back to global default.
 */
function getProviderNameForAgent(agent: AgentConfig, globalConfig: ProviderConfig): string {
  return agent.provider?.name ?? globalConfig.default;
}

/**
 * Helper to get the model for an agent.
 * Uses agent-specific model if configured, otherwise falls back to provider's default model.
 */
function getModelForAgent(agent: AgentConfig, globalConfig: ProviderConfig): string {
  if (agent.provider?.model) return agent.provider.model;
  const providerName = getProviderNameForAgent(agent, globalConfig);
  const providerDefaults = globalConfig[providerName as keyof Omit<ProviderConfig, "default">];
  return providerDefaults?.model ?? "claude-sonnet-4-20250514";
}

/**
 * Helper to get max tokens for an agent.
 */
function getMaxTokensForAgent(agent: AgentConfig, globalConfig: ProviderConfig): number {
  if (agent.provider?.maxTokens) return agent.provider.maxTokens;
  if (agent.limits?.maxTokens) return agent.limits.maxTokens;
  const providerName = getProviderNameForAgent(agent, globalConfig);
  const providerDefaults = globalConfig[providerName as keyof Omit<ProviderConfig, "default">];
  return providerDefaults?.maxTokens ?? 8192;
}

/**
 * Actor that creates a session for an agent.
 * Uses agent-specific provider config with fallback to global defaults.
 */
export const createAgentSession = fromPromise<CreateAgentSessionOutput, CreateAgentSessionInput>(
  async ({ input }) => {
    const { agent, providerConfig } = input;

    const primaryProvider = getProviderNameForAgent(agent, providerConfig);
    const fallbackProvider = providerConfig.default;
    const model = getModelForAgent(agent, providerConfig);
    const maxTokens = getMaxTokensForAgent(agent, providerConfig);

    console.log(`[rawko] Agent '${agent.name}' using provider: ${primaryProvider}, model: ${model}`);

    const result = await ProviderFactory.createSessionWithFallback({
      primaryProvider,
      fallbackProvider,
      config: {
        model,
        maxTokens,
      },
      onFallback: (error, fallbackName) => {
        console.warn(
          `[rawko] Provider '${primaryProvider}' failed for agent '${agent.name}': ${error.message}. ` +
          `Falling back to '${fallbackName}'`,
        );
      },
    });

    return {
      session: result.session,
      providerName: result.providerName,
      usedFallback: result.usedFallback,
    };
  },
);

interface SelectAgentActorInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastError: Error | null;
  agents: Map<string, AgentConfig>;
  arbiterConfig: ArbiterConfig;
  defaultAgent: string;
  iterationCount: number;
  consecutiveFailures: number;
  maxIterations: number;
  maxConsecutiveFailures: number;
  startedAt: Date;
  currentMode: string | null;
}

interface SelectAgentOutput {
  agent: AgentConfig;
  decision: ArbiterDecision;
}

/**
 * Actor that selects the next agent using the arbiter.
 * Uses enriched context construction from SPEC-0006.
 */
export const arbiterSelectAgent = fromPromise<SelectAgentOutput, SelectAgentActorInput>(
  async ({ input }) => {
    const {
      task,
      plan,
      history,
      lastError,
      agents,
      arbiterConfig,
      defaultAgent,
      iterationCount,
      consecutiveFailures,
      maxIterations,
      maxConsecutiveFailures,
      startedAt,
      currentMode,
    } = input;

    // Build context snapshot for enriched context construction
    const contextSnapshot: MachineContextSnapshot = {
      task,
      plan,
      history,
      lastError,
      agents,
      currentMode,
      iterationCount,
      consecutiveFailures,
      maxIterations,
      maxConsecutiveFailures,
      startedAt,
      defaultAgent,
    };

    // Construct enriched arbiter input
    const selectAgentInput = constructSelectAgentInput(contextSnapshot);

    const arbiter = new Arbiter({ config: arbiterConfig });

    try {
      const decision = await arbiter.selectAgent(selectAgentInput);

      if (decision.type !== "SELECT_MODE") {
        // If arbiter says complete, we need to handle this specially
        throw new Error(`Arbiter returned ${decision.type} during agent selection`);
      }

      const agent = agents.get(decision.mode);
      if (!agent) {
        throw new Error(`Arbiter selected unknown agent: ${decision.mode}`);
      }

      return { agent, decision };
    } finally {
      await arbiter.close();
    }
  },
);

interface ExecuteAgentInput {
  agent: AgentConfig;
  session: ProviderSession;
  task: string;
  plan: Plan | null;
  messages: RawkoContext["messages"];
  toolRegistry: ToolRegistry;
}

/**
 * Actor that executes an agent.
 */
export const agentExecutor = fromCallback<
  { type: "AGENT_MESSAGE" | "AGENT_TOOL_CALL" | "AGENT_COMPLETE" | "AGENT_ERROR"; [key: string]: unknown },
  ExecuteAgentInput
>(({ input, sendBack }) => {
  const executor = new AgentExecutor();

  (async () => {
    try {
      for await (const event of executor.execute(input)) {
        switch (event.type) {
          case "text":
            sendBack({
              type: "AGENT_MESSAGE",
              message: { role: "assistant" as const, content: event.content },
            });
            break;

          case "tool_call":
            sendBack({
              type: "AGENT_TOOL_CALL",
              toolCall: { id: crypto.randomUUID(), name: event.name, arguments: event.input },
            });
            break;

          case "complete":
            sendBack({
              type: "AGENT_COMPLETE",
              result: event.result,
            });
            break;

          case "error":
            sendBack({
              type: "AGENT_ERROR",
              error: event.error,
            });
            break;
        }
      }
    } catch (error) {
      sendBack({
        type: "AGENT_ERROR",
        error: error as Error,
      });
    }
  })();

  return () => {
    // Cleanup if needed
  };
});

interface EvaluateProgressActorInput {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastExecution: ExecutionEntry;
  arbiterConfig: ArbiterConfig;
  iterationCount: number;
  consecutiveFailures: number;
  maxIterations: number;
  maxConsecutiveFailures: number;
  startedAt: Date;
  currentMode: string | null;
  agents: Map<string, AgentConfig>;
  defaultAgent: string;
  currentAgent: AgentConfig | null;
}

/**
 * Actor that evaluates progress using the arbiter.
 * Uses enriched context construction from SPEC-0006.
 */
export const arbiterEvaluate = fromPromise<ArbiterDecision, EvaluateProgressActorInput>(
  async ({ input }) => {
    const {
      task,
      plan,
      history,
      arbiterConfig,
      iterationCount,
      consecutiveFailures,
      maxIterations,
      maxConsecutiveFailures,
      startedAt,
      currentMode,
      agents,
      defaultAgent,
      currentAgent,
    } = input;

    // Build context snapshot for enriched context construction
    const contextSnapshot: MachineContextSnapshot = {
      task,
      plan,
      history,
      lastError: null,
      agents,
      currentMode,
      iterationCount,
      consecutiveFailures,
      maxIterations,
      maxConsecutiveFailures,
      startedAt,
      defaultAgent,
    };

    // Construct enriched arbiter input
    const evaluateInput = constructEvaluateProgressInput(contextSnapshot);

    const arbiter = new Arbiter({ config: arbiterConfig });

    try {
      // Pass currentAgent so arbiter can respect configured transitions
      return await arbiter.evaluateProgress({
        ...evaluateInput,
        currentAgent: currentAgent ?? undefined,
      });
    } finally {
      await arbiter.close();
    }
  },
);
