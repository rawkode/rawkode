/**
 * Initial context factory for the rawko state machine
 */

import type { RawkoContext, RawkoMachineInput } from "./types.ts";

/**
 * Create initial context for the machine.
 */
export function createInitialContext(input?: RawkoMachineInput): RawkoContext {
  return {
    task: "",
    startedAt: null,
    currentAgent: null,
    currentMode: "",
    agents: input?.agents ?? new Map(),
    plan: null,
    history: [],
    messages: [],
    consecutiveFailures: 0,
    totalFailures: 0,
    lastError: null,
    currentSession: null,
    currentProviderName: null,
    providerConfig: input?.providerConfig ?? { default: "claude" },
    lastArbiterDecision: null,
    maxIterations: input?.maxIterations ?? 50,
    iterationCount: 0,
    maxFailures: input?.maxFailures ?? 3,
    defaultAgent: input?.defaultAgent ?? "planner",
  };
}
