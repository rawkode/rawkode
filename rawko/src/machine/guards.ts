/**
 * Guard functions for the rawko state machine
 */

import type { RawkoContext, RawkoEvent } from "./types.ts";
import type { ArbiterDecision } from "../arbiter/types.ts";
import { ProviderError } from "../providers/types.ts";

type GuardArgs = {
  context: RawkoContext;
  event: RawkoEvent;
};

type DoneEvent = {
  type: string;
  output?: ArbiterDecision;
};

export const guards = {
  /**
   * Check if the arbiter decided the task is complete.
   */
  isComplete: ({ event }: { context: RawkoContext; event: DoneEvent }): boolean => {
    return event.output?.type === "COMPLETE";
  },

  /**
   * Check if the arbiter decided to retry.
   */
  shouldRetry: ({ event }: { context: RawkoContext; event: DoneEvent }): boolean => {
    return event.output?.type === "RETRY";
  },

  /**
   * Check if the arbiter decided to select a new mode.
   */
  shouldSelectMode: ({ event }: { context: RawkoContext; event: DoneEvent }): boolean => {
    return event.output?.type === "SELECT_MODE";
  },

  /**
   * Check if max iterations has been reached.
   */
  maxIterationsReached: ({ context }: GuardArgs): boolean => {
    return context.iterationCount >= context.maxIterations;
  },

  /**
   * Check if max consecutive failures has been reached.
   */
  maxFailuresReached: ({ context }: GuardArgs): boolean => {
    return context.consecutiveFailures >= context.maxFailures;
  },

  /**
   * Check if the error is recoverable.
   */
  isRecoverableError: ({ context }: GuardArgs): boolean => {
    const error = context.lastError;
    if (!error) return false;

    if (error instanceof ProviderError) {
      return ["rate_limited", "network_error"].includes(error.code);
    }

    return false;
  },

  /**
   * Check if an agent exists.
   */
  hasAgent: ({ context }: GuardArgs, params: { name: string }): boolean => {
    return context.agents.has(params.name);
  },

  /**
   * Check if a session is available.
   */
  hasSession: ({ context }: GuardArgs): boolean => {
    return context.currentSession !== null;
  },

  /**
   * Check if a plan exists.
   */
  hasPlan: ({ context }: GuardArgs): boolean => {
    return context.plan !== null;
  },

  /**
   * Check if plan is complete.
   */
  isPlanComplete: ({ context }: GuardArgs): boolean => {
    return context.plan?.status === "complete";
  },
};
