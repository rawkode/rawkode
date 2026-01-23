/**
 * Arbiter context construction functions (SPEC-0006)
 *
 * These functions transform raw machine context into rich, structured
 * inputs for arbiter decision-making.
 */

import type { AgentConfig } from "../config/types.ts";
import type {
  ExecutionEntry,
  ExecutionSummary,
  ErrorContext,
  ErrorCategory,
  ConstraintContext,
  AgentDescription,
  SelectAgentInput,
  EvaluateProgressInput,
  Plan,
  RecoveryOption,
} from "./types.ts";

export interface MachineContextSnapshot {
  task: string;
  plan: Plan | null;
  history: ExecutionEntry[];
  lastError: Error | null;
  agents: Map<string, AgentConfig>;
  currentMode: string | null;
  iterationCount: number;
  consecutiveFailures: number;
  maxIterations: number;
  maxConsecutiveFailures: number;
  startedAt: Date;
  defaultAgent: string;
}

/**
 * Construct SelectAgentInput from machine context
 */
export function constructSelectAgentInput(
  context: MachineContextSnapshot
): SelectAgentInput {
  const history = buildExecutionHistory(context.history, {
    maxEntries: 10,
    includeOutput: true,
    summarizeFailures: true,
  });

  const lastError = context.lastError
    ? buildErrorContext(context.lastError, context)
    : null;

  const availableAgents = buildAgentDescriptions(context.agents);

  const constraints = buildConstraintContext(context);

  return {
    task: context.task,
    plan: context.plan,
    history,
    lastError,
    availableAgents,
    constraints,
    defaultAgent: context.defaultAgent,
  };
}

/**
 * Construct EvaluateProgressInput from machine context
 */
export function constructEvaluateProgressInput(
  context: MachineContextSnapshot
): EvaluateProgressInput {
  const lastEntry = context.history[context.history.length - 1];

  const lastExecution = buildExecutionSummary(lastEntry, context.history.length, {
    includeFullOutput: true,
  });

  const history = buildExecutionHistory(context.history, {
    maxEntries: 5,
    includeOutput: true,
    summarizeFailures: true,
  });

  const constraints = buildConstraintContext(context);

  return {
    task: context.task,
    plan: context.plan,
    lastExecution,
    history,
    constraints,
  };
}

interface HistoryBuildOptions {
  maxEntries: number;
  includeOutput: boolean;
  summarizeFailures: boolean;
}

/**
 * Build execution history from raw entries
 */
export function buildExecutionHistory(
  fullHistory: ExecutionEntry[],
  options: HistoryBuildOptions
): ExecutionSummary[] {
  let entries = fullHistory.slice(-options.maxEntries);

  // If many failures, include more context for pattern recognition
  const failureCount = entries.filter((e) => e.result === "failure").length;
  if (failureCount > 2 && options.summarizeFailures) {
    const failures = fullHistory.filter((e) => e.result === "failure").slice(-5);
    const nonFailures = entries.filter((e) => e.result !== "failure");
    entries = [...failures, ...nonFailures];
    // Deduplicate
    entries = [...new Map(entries.map((e) => [e.startedAt.toISOString(), e])).values()];
  }

  return entries.map((entry, idx) =>
    buildExecutionSummary(entry, fullHistory.indexOf(entry) + 1, {
      includeFullOutput: false,
    })
  );
}

interface ExecutionSummaryOptions {
  includeFullOutput: boolean;
}

/**
 * Build a single execution summary
 */
export function buildExecutionSummary(
  entry: ExecutionEntry,
  iteration: number,
  options: ExecutionSummaryOptions
): ExecutionSummary {
  const durationMs = entry.completedAt
    ? entry.completedAt.getTime() - entry.startedAt.getTime()
    : 0;

  const status = entry.result === "success"
    ? "success"
    : entry.result === "failure"
    ? "failure"
    : "cancelled";

  const summary: ExecutionSummary = {
    agent: entry.agent,
    iteration,
    status,
    durationMs,
    startedAt: entry.startedAt.toISOString(),
    completedAt: entry.completedAt?.toISOString(),
  };

  // Include output
  if (entry.output) {
    const maxLength = options.includeFullOutput ? 2000 : 300;
    summary.output = {
      summary: truncateOutput(entry.output, maxLength),
      filesModified: extractFilesFromOutput(entry.output),
    };
  }

  // Include error info
  if (entry.error) {
    summary.error = {
      message: entry.error,
      category: "unknown",
      recoveryOptions: [],
    };
  }

  // Include token usage
  if (entry.tokenUsage) {
    summary.tokens = entry.tokenUsage;
  }

  return summary;
}

/**
 * Build rich error context from an Error
 */
export function buildErrorContext(
  error: Error,
  context: MachineContextSnapshot
): ErrorContext {
  const category = categorizeError(error);
  const recoveryOptions = buildRecoveryOptions(category, context);
  const tool = extractToolFromError(error);

  return {
    agent: context.currentMode || "unknown",
    tool,
    planStep: context.plan?.currentStepIndex,
    attempted: buildAttemptedDescription(context),
    message: error.message,
    category,
    recoveryOptions,
    timestamp: new Date().toISOString(),
    context: extractErrorAdditionalContext(error),
  };
}

/**
 * Categorize an error
 */
function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();

  if (message.includes("rate_limit") || message.includes("rate limit")) {
    return "provider_error";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("permission") || message.includes("denied") || message.includes("forbidden")) {
    return "permission_error";
  }
  if (message.includes("validation") || message.includes("invalid")) {
    return "validation_error";
  }
  if (message.includes("tool") || message.includes("command") || message.includes("bash")) {
    return "tool_failure";
  }

  return "unknown";
}

/**
 * Build recovery options based on error category
 */
function buildRecoveryOptions(
  category: ErrorCategory,
  context: MachineContextSnapshot
): RecoveryOption[] {
  const options: RecoveryOption[] = [];

  switch (category) {
    case "tool_failure":
      options.push({
        action: "retry",
        description: "Retry the same tool with different parameters",
        reason: "Tool may be in temporary error state",
      });
      options.push({
        action: "skip",
        description: "Skip this step and proceed to next",
        reason: "Step may not be critical to task",
      });
      break;

    case "provider_error":
      options.push({
        action: "retry",
        description: "Wait and retry (rate limit should clear)",
        reason: "Rate limit is temporary",
      });
      break;

    case "timeout":
      options.push({
        action: "abort",
        description: "Abort task due to timeout",
        reason: "Agent not making progress",
      });
      break;

    case "permission_error":
      options.push({
        action: "skip",
        description: "Skip this operation",
        reason: "Permission issue cannot be resolved by agent",
      });
      break;

    case "validation_error":
      options.push({
        action: "retry",
        description: "Retry with corrected input",
        reason: "Input can be fixed",
      });
      break;
  }

  // Always offer fallback
  options.push({
    action: "fallback",
    description: "Switch to different agent",
    reason: "Different agent may have better approach",
  });

  return options;
}

/**
 * Build agent descriptions for selection
 */
function buildAgentDescriptions(
  agents: Map<string, AgentConfig>
): AgentDescription[] {
  return Array.from(agents.values()).map((agent) => ({
    name: agent.name,
    displayName: agent.displayName || agent.name,
    whenToUse: agent.whenToUse,
    tools: agent.tools
      ? {
          allowed: agent.tools.allowed,
          blocked: agent.tools.blocked,
        }
      : undefined,
  }));
}

/**
 * Build constraint context
 */
function buildConstraintContext(context: MachineContextSnapshot): ConstraintContext {
  const timeElapsedMs = Date.now() - context.startedAt.getTime();

  // Estimate tokens used from history
  const estimatedTokensUsed = context.history.reduce((total, entry) => {
    if (entry.tokenUsage) {
      return total + (entry.tokenUsage.inputTokens || 0) + (entry.tokenUsage.outputTokens || 0);
    }
    return total;
  }, 0);

  return {
    maxIterations: context.maxIterations,
    currentIteration: context.iterationCount,
    iterationsRemaining: context.maxIterations - context.iterationCount,
    consecutiveFailures: context.consecutiveFailures,
    maxConsecutiveFailures: context.maxConsecutiveFailures,
    estimatedTokensUsed,
    timeElapsedMs,
  };
}

/**
 * Build description of what was being attempted
 */
function buildAttemptedDescription(context: MachineContextSnapshot): string {
  if (context.plan && context.plan.currentStepIndex < context.plan.steps.length) {
    const step = context.plan.steps[context.plan.currentStepIndex];
    return `Working on step ${step.index + 1}: ${step.description}`;
  }
  return `Working on task: ${context.task.substring(0, 100)}`;
}

/**
 * Extract tool name from error message
 */
function extractToolFromError(error: Error): string | undefined {
  const message = error.message;
  const toolPatterns = [
    /tool[:\s]+['"]?(\w+)['"]?/i,
    /(\w+)\s+tool/i,
    /(Bash|Read|Write|Edit|Glob|Grep)/,
  ];

  for (const pattern of toolPatterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Extract additional context from error
 */
function extractErrorAdditionalContext(
  error: Error
): { filesAccessed?: string[]; commandExecuted?: string } {
  const context: { filesAccessed?: string[]; commandExecuted?: string } = {};

  // Try to extract file paths from error message
  const filePattern = /(?:\/[\w\-./]+\.\w+)/g;
  const files = error.message.match(filePattern);
  if (files && files.length > 0) {
    context.filesAccessed = [...new Set(files)];
  }

  // Try to extract command from error message
  const cmdPattern = /command[:\s]+[`']?([^`'\n]+)[`']?/i;
  const cmdMatch = error.message.match(cmdPattern);
  if (cmdMatch) {
    context.commandExecuted = cmdMatch[1].trim();
  }

  return context;
}

/**
 * Truncate output to max length
 */
function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }
  return output.substring(0, maxLength) + "...";
}

/**
 * Extract file paths from output
 */
function extractFilesFromOutput(output: string): string[] {
  const filePatterns = [
    /(?:created|modified|wrote|edited|updated)[:\s]+([^\s\n]+)/gi,
    /(?:\/[\w\-./]+\.\w+)/g,
  ];

  const files: string[] = [];
  for (const pattern of filePatterns) {
    const matches = output.matchAll(pattern);
    for (const match of matches) {
      const file = match[1] || match[0];
      if (file && file.includes("/") && file.includes(".")) {
        files.push(file);
      }
    }
  }

  return [...new Set(files)];
}
