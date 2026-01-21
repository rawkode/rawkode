import { createMachine, assign } from "xstate";
import type { PhaseGraph, PhaseConfig } from "./schema.ts";

// Dynamic context type that holds all phase data
export interface DynamicMachineContext {
  iteration: number;
  maxIterations: number;
  currentPhase: string;
  history: Array<{
    phase: string;
    timestamp: Date;
    event: string;
    data?: unknown;
  }>;
  error?: string;
  // Dynamic data from phase executions
  [key: string]: unknown;
}

// Generic event type for the dynamic machine
export interface DynamicMachineEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Generate an XState machine configuration from a phase graph
 */
export function generateMachineConfig(graph: PhaseGraph) {
  const states: Record<string, unknown> = {};

  for (const [phaseId, phase] of graph.phases) {
    states[phaseId] = buildStateConfig(phase, graph);
  }

  return {
    id: "rocko-dynamic",
    initial: graph.initialPhaseId,
    context: ({ input }: { input?: Partial<DynamicMachineContext> }) => ({
      iteration: input?.iteration ?? 1,
      maxIterations: input?.maxIterations ?? 5,
      currentPhase: graph.initialPhaseId,
      history: input?.history ?? [],
      error: input?.error,
      ...input,
    }),
    states,
  };
}

/**
 * Build XState state configuration for a single phase
 */
function buildStateConfig(phase: PhaseConfig, _graph: PhaseGraph): unknown {
  const config: Record<string, unknown> = {
    entry: assign({
      currentPhase: phase.id,
      history: ({ context }: { context: DynamicMachineContext }) => [
        ...context.history,
        { phase: phase.id, timestamp: new Date(), event: "entered" },
      ],
    }),
  };

  // Mark final states
  if (phase.final) {
    config.type = "final";
  }

  // Build transitions
  if (phase.transitions.length > 0) {
    const on: Record<string, unknown> = {};

    for (const transition of phase.transitions) {
      // Group transitions by event type (for multiple conditions on same event)
      if (!on[transition.event]) {
        on[transition.event] = [];
      }

      const transitionConfig: Record<string, unknown> = {
        target: transition.target,
        actions: assign({
          history: ({ context, event }: { context: DynamicMachineContext; event: DynamicMachineEvent }) => [
            ...context.history,
            {
              phase: phase.id,
              timestamp: new Date(),
              event: transition.event,
              data: event,
            },
          ],
        }),
      };

      // Add guard if there's a when condition
      if (transition.when || transition.guard) {
        transitionConfig.guard = ({ context, event }: { context: DynamicMachineContext; event: DynamicMachineEvent }) => {
          try {
            // Combine when and guard conditions
            const conditions: string[] = [];
            if (transition.when) conditions.push(transition.when);
            if (transition.guard) conditions.push(transition.guard);

            const combinedCondition = conditions.join(" && ");
            // eslint-disable-next-line no-new-func
            const fn = new Function("context", "event", `return (${combinedCondition})`);
            return fn(context, event);
          } catch {
            return false;
          }
        };
      }

      (on[transition.event] as unknown[]).push(transitionConfig);
    }

    // Flatten single-transition arrays
    for (const eventType of Object.keys(on)) {
      const transitions = on[eventType] as unknown[];
      if (transitions.length === 1) {
        on[eventType] = transitions[0];
      }
    }

    config.on = on;
  }

  return config;
}

/**
 * Create an XState machine from a phase graph
 */
export function createDynamicMachine(graph: PhaseGraph) {
  const config = generateMachineConfig(graph);

  return createMachine(config as any);
}

/**
 * Build event data with assignments from phase configuration
 */
export function buildEventData(
  phase: PhaseConfig,
  eventType: string,
  response: unknown,
  context: DynamicMachineContext
): DynamicMachineEvent {
  const transition = phase.transitions.find((t) => t.event === eventType);
  const eventData: DynamicMachineEvent = { type: eventType };

  if (transition?.assign) {
    for (const [key, valuePath] of Object.entries(transition.assign)) {
      if (valuePath === "response") {
        eventData[key] = response;
      } else if (valuePath.startsWith("response.")) {
        const path = valuePath.slice(9); // Remove "response."
        eventData[key] = getNestedValue(response, path);
      } else if (valuePath.startsWith("context.")) {
        const path = valuePath.slice(8); // Remove "context."
        eventData[key] = getNestedValue(context, path);
      } else {
        // Treat as literal value
        eventData[key] = valuePath;
      }
    }
  }

  return eventData;
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export type DynamicMachine = ReturnType<typeof createDynamicMachine>;
