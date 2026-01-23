/**
 * XState machine definition for rawko-sdk
 */

import { setup, assign } from "xstate";
import type { RawkoContext, RawkoEvent, RawkoMachineInput } from "./types.ts";
import { createInitialContext } from "./context.ts";
import { guards } from "./guards.ts";
import { actions, createExecutionEntry, cleanupSession } from "./actions.ts";
import { arbiterSelectAgent, agentExecutor, arbiterEvaluate, createAgentSession } from "./actors.ts";
import type { ArbiterConfig, ProviderConfig } from "../config/types.ts";
import { ToolRegistry, defaultToolRegistry } from "../tools/registry.ts";

export interface RawkoMachineOptions {
  input?: RawkoMachineInput;
  arbiterConfig: ArbiterConfig;
  providerConfig?: ProviderConfig;
  toolRegistry?: ToolRegistry;
}

export function createRawkoMachine(options: RawkoMachineOptions) {
  const { arbiterConfig, providerConfig, toolRegistry = defaultToolRegistry } = options;

  return setup({
    types: {
      context: {} as RawkoContext,
      events: {} as RawkoEvent,
      input: {} as RawkoMachineInput,
    },
    actors: {
      arbiterSelectAgent,
      createAgentSession,
      agentExecutor,
      arbiterEvaluate,
    },
    guards,
    actions: {
      ...actions,
      cleanupSession: async ({ context }) => {
        await cleanupSession(context);
      },
    },
  }).createMachine({
    id: "rawko",
    initial: "idle",
    context: ({ input }) => createInitialContext(input),

    states: {
      idle: {
        description: "Waiting for a task to begin",
        on: {
          START_TASK: {
            target: "selecting",
            actions: [
              assign({
                task: ({ event }) => event.task,
                startedAt: () => new Date(),
                iterationCount: 0,
                consecutiveFailures: 0,
                history: [],
                messages: [],
                lastError: null,
              }),
              "logTaskStart",
            ],
          },
        },
      },

      selecting: {
        description: "Arbiter is selecting the next agent",
        invoke: {
          id: "selectAgent",
          src: "arbiterSelectAgent",
          input: ({ context }) => ({
            task: context.task,
            plan: context.plan,
            history: context.history,
            lastError: context.lastError,
            agents: context.agents,
            arbiterConfig,
            defaultAgent: context.defaultAgent,
            iterationCount: context.iterationCount,
            consecutiveFailures: context.consecutiveFailures,
            maxIterations: context.maxIterations,
            maxConsecutiveFailures: context.maxFailures,
            startedAt: context.startedAt ?? new Date(),
            currentMode: context.currentMode,
          }),
          onDone: {
            target: "preparingSession",
            actions: assign({
              currentAgent: ({ event }) => event.output.agent,
              currentMode: ({ event }) => event.output.agent.name,
              lastArbiterDecision: ({ event }) => event.output.decision,
            }),
          },
          onError: {
            target: "error_handling",
            actions: assign({
              lastError: ({ event }) => event.error as Error,
            }),
          },
        },
      },

      preparingSession: {
        description: "Creating session for the selected agent",
        invoke: {
          id: "createSession",
          src: "createAgentSession",
          input: ({ context }) => ({
            agent: context.currentAgent!,
            providerConfig: context.providerConfig,
          }),
          onDone: {
            target: "executing",
            actions: assign({
              currentSession: ({ event }) => event.output.session,
              currentProviderName: ({ event }) => event.output.providerName,
            }),
          },
          onError: {
            target: "error_handling",
            actions: assign({
              lastError: ({ event }) => event.error as Error,
            }),
          },
        },
      },

      executing: {
        description: "An agent is actively working",
        entry: [
          assign({
            iterationCount: ({ context }) => context.iterationCount + 1,
          }),
          "logAgentStart",
        ],
        invoke: {
          id: "executeAgent",
          src: "agentExecutor",
          input: ({ context }) => ({
            agent: context.currentAgent!,
            session: context.currentSession!,
            task: context.task,
            plan: context.plan,
            messages: context.messages,
            toolRegistry,
          }),
        },
        on: {
          AGENT_MESSAGE: {
            actions: "streamMessage",
          },
          AGENT_TOOL_CALL: {
            actions: "logToolCall",
          },
          AGENT_COMPLETE: {
            target: "evaluating",
            actions: [
              assign({
                messages: ({ context, event }) => [
                  ...context.messages,
                  ...(event.result.messages ?? []),
                ],
                plan: ({ context, event }) =>
                  event.result.planUpdates
                    ? { ...context.plan!, ...event.result.planUpdates }
                    : context.plan,
                consecutiveFailures: 0,
                history: ({ context, event }) => [
                  ...context.history,
                  createExecutionEntry(
                    context.currentMode,
                    event.result.success ? "success" : "failure",
                    event.result.output,
                  ),
                ],
              }),
              "logAgentComplete",
            ],
          },
          AGENT_ERROR: {
            target: "error_handling",
            actions: [
              assign({
                lastError: ({ event }) => event.error,
                consecutiveFailures: ({ context }) =>
                  context.consecutiveFailures + 1,
                totalFailures: ({ context }) => context.totalFailures + 1,
                history: ({ context, event }) => [
                  ...context.history,
                  createExecutionEntry(
                    context.currentMode,
                    "failure",
                    undefined,
                    event.error.message,
                  ),
                ],
              }),
              "logAgentError",
            ],
          },
          CANCEL: {
            target: "cancelled",
          },
        },
      },

      evaluating: {
        description: "Arbiter is evaluating progress and deciding next steps",
        invoke: {
          id: "evaluateProgress",
          src: "arbiterEvaluate",
          input: ({ context }) => ({
            task: context.task,
            plan: context.plan,
            history: context.history,
            lastExecution: context.history[context.history.length - 1],
            arbiterConfig,
            iterationCount: context.iterationCount,
            consecutiveFailures: context.consecutiveFailures,
            maxIterations: context.maxIterations,
            maxConsecutiveFailures: context.maxFailures,
            startedAt: context.startedAt ?? new Date(),
            currentMode: context.currentMode,
            agents: context.agents,
            defaultAgent: context.defaultAgent,
            currentAgent: context.currentAgent,
          }),
          onDone: [
            {
              guard: "isComplete",
              target: "complete",
              actions: assign({
                lastArbiterDecision: ({ event }) => event.output,
              }),
            },
            {
              guard: "maxIterationsReached",
              target: "complete",
              actions: [
                assign({
                  lastArbiterDecision: () => ({
                    type: "COMPLETE" as const,
                    summary: "Max iterations reached",
                  }),
                }),
                "logMaxIterations",
              ],
            },
            {
              // When evaluateProgress returns SELECT_MODE, go directly to preparingSession
              // This avoids calling selectAgent again (which would query the LLM)
              guard: "shouldSelectMode",
              target: "preparingSession",
              actions: assign({
                lastArbiterDecision: ({ event }) => event.output,
                currentAgent: ({ context, event }) => {
                  const decision = event.output;
                  if (decision.type === "SELECT_MODE") {
                    return context.agents.get(decision.mode) ?? context.currentAgent;
                  }
                  return context.currentAgent;
                },
                currentMode: ({ context, event }) => {
                  const decision = event.output;
                  if (decision.type === "SELECT_MODE") {
                    return decision.mode;
                  }
                  return context.currentMode;
                },
              }),
            },
            {
              guard: "shouldRetry",
              target: "selecting",
              actions: assign({
                lastArbiterDecision: ({ event }) => event.output,
              }),
            },
            {
              target: "selecting",
              actions: assign({
                lastArbiterDecision: ({ event }) => event.output,
              }),
            },
          ],
          onError: {
            target: "error_handling",
            actions: assign({
              lastError: ({ event }) => event.error as Error,
            }),
          },
        },
      },

      error_handling: {
        description: "Handling an error that occurred during execution",
        always: [
          {
            guard: "maxFailuresReached",
            target: "failed",
            actions: "logMaxFailures",
          },
          {
            guard: "isRecoverableError",
            target: "selecting",
            actions: "logRecovery",
          },
          {
            target: "failed",
          },
        ],
      },

      complete: {
        type: "final",
        description: "Task completed successfully",
        entry: ["logCompletion", "cleanupSession"],
      },

      failed: {
        type: "final",
        description: "Task failed after maximum retries",
        entry: ["logFailure", "cleanupSession"],
      },

      cancelled: {
        type: "final",
        description: "Task was cancelled by user",
        entry: ["logCancellation", "cleanupSession"],
      },
    },
  });
}

export type RawkoMachine = ReturnType<typeof createRawkoMachine>;
