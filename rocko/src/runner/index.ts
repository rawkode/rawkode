import { createActor } from "xstate";
import { readState, writeState } from "../state/index.ts";
import { loadBuiltinAdapters, createAdapter } from "../adapter/registry.ts";
import type { Task } from "../adapter/types.ts";
import type { RockoConfig } from "../config/schema.ts";
import {
  loadPhases,
  createDynamicMachine,
  executePhase,
  buildExecutionContext,
  type DynamicMachineContext,
  type PhaseGraph,
  NoPhaseConfiguredError,
} from "../phases/index.ts";

export interface RunnerOptions {
  config: RockoConfig;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface RunnerResult {
  success: boolean;
  iterations: number;
  tasksCompleted: Task[];
  error?: string;
}

export async function run(options: RunnerOptions): Promise<RunnerResult> {
  const { config, dryRun = false, verbose = false } = options;

  // Load phases from .rocko/phases/
  let phaseGraph: PhaseGraph;
  try {
    phaseGraph = await loadPhases();
  } catch (error) {
    if (error instanceof NoPhaseConfiguredError) {
      throw error;
    }
    throw new Error(`Failed to load phases: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (verbose) {
    console.log(`[ROCKO] Loaded ${phaseGraph.phases.size} phases`);
    console.log(`[ROCKO] Initial phase: ${phaseGraph.initialPhaseId}`);
    console.log(`[ROCKO] Final phases: ${phaseGraph.finalPhaseIds.join(", ")}`);
  }

  // Load adapters and create adapter instance
  await loadBuiltinAdapters();
  const adapter = await createAdapter(config.adapter);

  if ("setGitHubConfig" in adapter && typeof adapter.setGitHubConfig === "function") {
    (adapter as any).setGitHubConfig(config.github);
  }

  // Create dynamic machine from phase graph
  const machine = createDynamicMachine(phaseGraph);

  // Load existing state or create initial context
  const existingState = await readState();
  const initialContext: Partial<DynamicMachineContext> = existingState
    ? {
        iteration: existingState.iteration,
        maxIterations: existingState.maxIterations,
        currentPhase: existingState.currentPhase,
        history: existingState.history.map((h) => ({
          phase: h.phase,
          timestamp: h.timestamp,
          event: h.event,
          data: h.data,
        })),
        error: existingState.error,
        task: existingState.task,
        plan: existingState.plan,
        build: existingState.build,
        review: existingState.review,
        commit: existingState.commit,
      }
    : { maxIterations: config.maxIterations };

  // Create and start the actor
  const actor = createActor(machine, {
    input: initialContext,
  });

  const tasksCompleted: Task[] = [];
  actor.start();

  if (verbose) {
    console.log(`[ROCKO] Starting with max ${config.maxIterations} iterations`);
  }

  try {
    // Main execution loop
    while (!actor.getSnapshot().status.startsWith("done")) {
      const snapshot = actor.getSnapshot();
      const context = snapshot.context as DynamicMachineContext;
      const currentPhaseId = context.currentPhase;

      // Persist state
      await writeState({
        currentPhase: context.currentPhase as any,
        iteration: context.iteration,
        maxIterations: context.maxIterations,
        history: context.history.map((h) => ({
          phase: h.phase as any,
          timestamp: h.timestamp,
          event: h.event,
          data: h.data,
        })),
        task: context.task as any,
        plan: context.plan as any,
        build: context.build as any,
        review: context.review as any,
        commit: context.commit as any,
        error: context.error,
      });

      if (verbose) {
        console.log(`[ROCKO] Phase: ${currentPhaseId}, Iteration: ${context.iteration}`);
      }

      // Get the current phase configuration
      const phase = phaseGraph.phases.get(currentPhaseId);
      if (!phase) {
        throw new Error(`Phase not found: ${currentPhaseId}`);
      }

      // Final phases end the loop
      if (phase.final) {
        if (verbose) {
          console.log(`[ROCKO] Reached final phase: ${currentPhaseId}`);
        }
        break;
      }

      // Get adapter context for template rendering
      const adapterContext = await adapter.getContext();

      if (verbose && currentPhaseId === "plan") {
        console.log(`[PLAN] Found ${adapterContext.tasks.length} tasks`);
      }

      // Build execution context
      const executionContext = buildExecutionContext(adapterContext, context);

      // Execute the phase with streaming output
      let hasStreamed = false;
      const result = await executePhase({
        phase,
        executionContext,
        aiConfig: config.ai,
        verbose,
        onStream: (delta) => {
          hasStreamed = true;
          process.stdout.write(delta);
        },
      });

      // Add newline after streaming output
      if (hasStreamed) {
        console.log("");
      }

      if (verbose) {
        console.log(`[${currentPhaseId.toUpperCase()}] Event: ${result.event}`);
      }

      // Handle special cases based on phase
      if (currentPhaseId === "plan" && result.event === "START_BUILD") {
        const task = (result.response as any)?.task;
        if (task && adapter.hooks?.onTaskSelected) {
          await adapter.hooks.onTaskSelected(task);
        }
      }

      if (currentPhaseId === "commit" && result.event === "COMMITTED") {
        const task = context.task as Task | undefined;
        if (task) {
          tasksCompleted.push(task);
          if (adapter.hooks?.onTaskComplete) {
            await adapter.hooks.onTaskComplete(task, "Task completed");
          }
          if (!dryRun && adapter.completeTask) {
            await adapter.completeTask(task.id);
          }
        }
      }

      // Handle phase transitions for hooks
      if (adapter.hooks?.onPhaseTransition) {
        const transition = phase.transitions.find((t) => t.event === result.event);
        if (transition) {
          await adapter.hooks.onPhaseTransition(
            currentPhaseId as any,
            transition.target as any,
            result.event
          );
        }
      }

      // Build event data with assignments
      const eventData: Record<string, unknown> = { type: result.event };

      // Apply assignments from the transition
      if (result.assignments) {
        for (const [key, valuePath] of Object.entries(result.assignments)) {
          if (valuePath === "response") {
            eventData[key] = result.response;
          } else if (valuePath.startsWith("response.")) {
            const path = valuePath.slice(9);
            eventData[key] = getNestedValue(result.response, path);
          } else if (valuePath.startsWith("context.")) {
            const path = valuePath.slice(8);
            eventData[key] = getNestedValue(context, path);
          } else {
            eventData[key] = valuePath;
          }
        }
      }

      // Handle dry run for commit phase
      if (currentPhaseId === "commit" && dryRun) {
        if (verbose) {
          console.log("[COMMIT] Dry run - skipping actual commit");
        }
      }

      // Send event to state machine
      actor.send(eventData as any);
    }

    // Final state persistence
    const finalContext = actor.getSnapshot().context as DynamicMachineContext;
    await writeState({
      currentPhase: finalContext.currentPhase as any,
      iteration: finalContext.iteration,
      maxIterations: finalContext.maxIterations,
      history: finalContext.history.map((h) => ({
        phase: h.phase as any,
        timestamp: h.timestamp,
        event: h.event,
        data: h.data,
      })),
      task: finalContext.task as any,
      plan: finalContext.plan as any,
      build: finalContext.build as any,
      review: finalContext.review as any,
      commit: finalContext.commit as any,
      error: finalContext.error,
    });

    return {
      success: true,
      iterations: finalContext.iteration,
      tasksCompleted,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (verbose) {
      console.error(`[ROCKO] Error: ${errorMessage}`);
    }

    return {
      success: false,
      iterations: (actor.getSnapshot().context as DynamicMachineContext).iteration,
      tasksCompleted,
      error: errorMessage,
    };
  } finally {
    actor.stop();
  }
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

// Keep old exports for backwards compatibility
export { runPlanPhase } from "./plan.ts";
export { runBuildPhase } from "./build.ts";
export { runReviewPhase } from "./review.ts";
export { runCommitPhase } from "./commit.ts";
