import type { AIConfig } from "../config/schema.ts";
import type {
  PhaseConfig,
  PhaseExecutionContext,
  PhaseExecutionResult,
} from "./schema.ts";
import { buildEventData, type DynamicMachineContext } from "./generator.ts";
import { createExecutor, loadBuiltinExecutors } from "../executors/registry.ts";
import type { Executor, ExecutorConfig, StreamCallback } from "../executors/types.ts";

// Cache executors by phase ID for reuse
const executorCache = new Map<string, Executor>();
let executorsLoaded = false;

async function ensureExecutorsLoaded(): Promise<void> {
  if (!executorsLoaded) {
    await loadBuiltinExecutors();
    executorsLoaded = true;
  }
}

/**
 * Evaluate a condition expression against the context and response
 */
function evaluateCondition(
  condition: string,
  context: PhaseExecutionContext,
  response: unknown
): boolean {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("context", "response", "tasks", `return (${condition})`);
    return fn(context, response, context.tasks);
  } catch (error) {
    console.warn(`Failed to evaluate condition: ${condition}`, error);
    return false;
  }
}

export interface ExecutePhaseOptions {
  phase: PhaseConfig;
  executionContext: PhaseExecutionContext;
  aiConfig: AIConfig;
  verbose?: boolean;
  onStream?: StreamCallback;
}

/**
 * Execute a phase - use configured executor to process and determine transition
 */
export async function executePhase(
  options: ExecutePhaseOptions
): Promise<PhaseExecutionResult>;

/**
 * @deprecated Use options object instead
 */
export async function executePhase(
  phase: PhaseConfig,
  executionContext: PhaseExecutionContext,
  aiConfig: AIConfig,
  verbose?: boolean
): Promise<PhaseExecutionResult>;

export async function executePhase(
  phaseOrOptions: PhaseConfig | ExecutePhaseOptions,
  executionContext?: PhaseExecutionContext,
  aiConfig?: AIConfig,
  verbose = false
): Promise<PhaseExecutionResult> {
  // Handle both old and new signatures
  let phase: PhaseConfig;
  let execContext: PhaseExecutionContext;
  let config: AIConfig;
  let isVerbose: boolean;
  let onStream: StreamCallback | undefined;

  if ("phase" in phaseOrOptions) {
    // New options object signature
    phase = phaseOrOptions.phase;
    execContext = phaseOrOptions.executionContext;
    config = phaseOrOptions.aiConfig;
    isVerbose = phaseOrOptions.verbose ?? false;
    onStream = phaseOrOptions.onStream;
  } else {
    // Old positional arguments signature
    phase = phaseOrOptions;
    execContext = executionContext!;
    config = aiConfig!;
    isVerbose = verbose;
    onStream = undefined;
  }

  // Final phases don't need execution
  if (phase.final) {
    return { event: "__FINAL__" };
  }

  // If no prompts defined, this is a passthrough phase
  // Find first matching transition based on conditions
  if (!phase.systemPrompt && !phase.userPromptTemplate) {
    return findMatchingTransition(phase, execContext, undefined);
  }

  // Ensure executors are loaded
  await ensureExecutorsLoaded();

  // Get or create executor for this phase
  const executorConfig: ExecutorConfig = phase.ai?.executor ?? { type: "direct" };
  const cacheKey = `${phase.id}:${executorConfig.type}`;

  let executor = executorCache.get(cacheKey);
  if (!executor) {
    executor = await createExecutor(executorConfig);
    executorCache.set(cacheKey, executor);
  }

  // Default onStream to stdout if verbose and no callback provided
  const streamCallback = onStream ?? (isVerbose ? (delta: string) => process.stdout.write(delta) : undefined);

  // Execute the phase using the configured executor
  const response = await executor.execute({
    phase,
    executionContext: execContext,
    aiConfig: config,
    verbose: isVerbose,
    onStream: streamCallback,
  });

  // Use parsed response if available, otherwise use raw content
  const responseData = response.parsedResponse ?? response.content;

  // Find matching transition
  return findMatchingTransition(phase, execContext, responseData);
}

/**
 * Cleanup all cached executors
 */
export async function cleanupExecutors(): Promise<void> {
  for (const executor of executorCache.values()) {
    await executor.cleanup();
  }
  executorCache.clear();
}

/**
 * Find the first transition whose condition matches
 */
function findMatchingTransition(
  phase: PhaseConfig,
  context: PhaseExecutionContext,
  response: unknown
): PhaseExecutionResult {
  for (const transition of phase.transitions) {
    // If no condition, this transition always matches
    if (!transition.when) {
      return {
        event: transition.event,
        response,
        assignments: transition.assign,
      };
    }

    // Evaluate condition
    if (evaluateCondition(transition.when, context, response)) {
      return {
        event: transition.event,
        response,
        assignments: transition.assign,
      };
    }
  }

  // No transition matched - this shouldn't happen if phases are properly configured
  throw new Error(
    `No matching transition found in phase '${phase.id}'. ` +
    `Ensure at least one transition has no 'when' condition as a fallback.`
  );
}

/**
 * Apply assignments from a phase result to the machine context
 */
export function applyAssignments(
  result: PhaseExecutionResult,
  phase: PhaseConfig,
  context: DynamicMachineContext
): DynamicMachineContext {
  if (!result.assignments) {
    return context;
  }

  const newContext = { ...context };

  for (const [key, valuePath] of Object.entries(result.assignments)) {
    if (valuePath === "response") {
      newContext[key] = result.response;
    } else if (valuePath.startsWith("response.")) {
      const path = valuePath.slice(9);
      newContext[key] = getNestedValue(result.response, path);
    } else if (valuePath.startsWith("context.")) {
      const path = valuePath.slice(8);
      newContext[key] = getNestedValue(context, path);
    } else {
      newContext[key] = valuePath;
    }
  }

  return newContext;
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

/**
 * Build the execution context from adapter context and machine context
 */
export function buildExecutionContext(
  adapterContext: {
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      source: string;
      priority?: string;
      labels?: string[];
    }>;
    additionalContext?: string;
  },
  machineContext: DynamicMachineContext
): PhaseExecutionContext {
  return {
    tasks: adapterContext.tasks,
    additionalContext: adapterContext.additionalContext,
    iteration: machineContext.iteration,
    maxIterations: machineContext.maxIterations,
    currentPhase: machineContext.currentPhase,
    task: machineContext.task,
    plan: machineContext.plan,
    build: machineContext.build,
    review: machineContext.review,
    commit: machineContext.commit,
    error: machineContext.error,
    history: machineContext.history,
  };
}
