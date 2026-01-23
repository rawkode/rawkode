/**
 * Action implementations for the rawko state machine
 */

import type { RawkoContext, AgentResult } from "./types.ts";
import type { Message } from "../providers/types.ts";
import type { ExecutionEntry } from "../arbiter/types.ts";

interface ActionParams {
  context: RawkoContext;
  event?: Record<string, unknown>;
}

export const actions = {
  logTaskStart: ({ context }: ActionParams): void => {
    console.log(`[rawko] Starting task: ${context.task.slice(0, 100)}...`);
  },

  logAgentStart: ({ context }: ActionParams): void => {
    console.log(
      `[rawko] Agent '${context.currentMode}' starting (iteration ${context.iterationCount})`,
    );
  },

  logAgentComplete: ({ context }: ActionParams): void => {
    console.log(`[rawko] Agent '${context.currentMode}' completed`);
  },

  logAgentError: ({ context }: ActionParams): void => {
    console.error(
      `[rawko] Agent '${context.currentMode}' error:`,
      context.lastError?.message,
    );
  },

  logCompletion: ({ context }: ActionParams): void => {
    console.log(
      `[rawko] Task completed in ${context.iterationCount} iterations`,
    );
  },

  logFailure: ({ context }: ActionParams): void => {
    console.error(
      `[rawko] Task failed after ${context.totalFailures} failures`,
    );
    if (context.lastError) {
      console.error(`[rawko] Last error: ${context.lastError.message}`);
    }
  },

  logCancellation: (): void => {
    console.log(`[rawko] Task cancelled`);
  },

  logMaxIterations: ({ context }: ActionParams): void => {
    console.warn(
      `[rawko] Max iterations (${context.maxIterations}) reached`,
    );
  },

  logMaxFailures: ({ context }: ActionParams): void => {
    console.error(
      `[rawko] Max consecutive failures (${context.consecutiveFailures}) reached`,
    );
  },

  logRecovery: ({ context }: ActionParams): void => {
    console.log(
      `[rawko] Recovering from error: ${context.lastError?.message}`,
    );
  },

  streamMessage: ({ event }: ActionParams): void => {
    const message = event?.message as Message | undefined;
    if (message?.role === "assistant") {
      Deno.stdout.writeSync(new TextEncoder().encode(message.content));
    }
  },

  logToolCall: ({ event }: ActionParams): void => {
    const toolCall = event?.toolCall as { name: string } | undefined;
    if (toolCall) {
      console.log(`[rawko] Tool call: ${toolCall.name}`);
    }
  },
};

/**
 * Create a new execution entry for the history.
 */
export function createExecutionEntry(
  agent: string,
  result: "success" | "failure" | "cancelled",
  output?: string,
  error?: string,
): ExecutionEntry {
  return {
    agent,
    startedAt: new Date(),
    completedAt: new Date(),
    result,
    output,
    error,
  };
}

/**
 * Cleanup session when done.
 */
export async function cleanupSession(context: RawkoContext): Promise<void> {
  if (context.currentSession) {
    await context.currentSession.close();
  }
}
