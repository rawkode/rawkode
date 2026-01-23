/**
 * Prompt templates for arbiter decisions
 * Updated for SPEC-0006 rich context
 */

import type {
  SelectAgentInput,
  EvaluateProgressInput,
  Plan,
  ExecutionSummary,
  ErrorContext,
  ConstraintContext,
  AgentDescription,
  GeneratePlanInput,
} from "./types.ts";
import type { AgentDefinition } from "../config/typescript-config.ts";
import type { MemoryMetadata } from "../memory/types.ts";

export function buildSelectAgentPrompt(input: SelectAgentInput): string {
  const { task, plan, history, lastError, availableAgents, constraints, defaultAgent } = input;

  const agentDescriptions = formatAgentDescriptions(availableAgents);
  const historySection = history.length > 0
    ? `\n## Execution History\n${formatExecutionHistory(history)}`
    : "";
  const planSection = plan ? `\n## Current Plan\n${formatPlan(plan)}` : "";
  const errorSection = lastError ? `\n## Last Error\n${formatErrorContext(lastError)}` : "";
  const constraintsSection = `\n## Current Progress\n${formatConstraints(constraints)}`;

  return `# Agent Selection

You are deciding which agent should work on the current task. Analyze the situation and select the most appropriate agent.

## Task
${task}
${planSection}
${historySection}
${errorSection}
${constraintsSection}

## Available Agents
${agentDescriptions}

## Instructions

Based on the task, plan status, execution history, errors, and progress constraints, select the most appropriate agent.

${defaultAgent ? `The default starting agent is "${defaultAgent}".` : ""}

Respond with a JSON object in this exact format:
\`\`\`json
{
  "type": "SELECT_MODE",
  "mode": "<agent_name>",
  "reason": "<brief explanation of why this agent was selected>"
}
\`\`\`

If the task appears complete, respond with:
\`\`\`json
{
  "type": "COMPLETE",
  "summary": "<brief summary of what was accomplished>"
}
\`\`\``;
}

export function buildEvaluateProgressPrompt(input: EvaluateProgressInput, currentAgent?: AgentDefinition): string {
  const { task, plan, history, lastExecution, constraints } = input;

  const planSection = plan ? `\n## Current Plan\n${formatPlan(plan)}` : "";
  const constraintsSection = `\n## Current Progress\n${formatConstraints(constraints)}`;
  const transitionSection = currentAgent ? `\n## Current Agent Transitions\n${formatTransitions(currentAgent)}` : "";

  return `# Progress Evaluation

You are evaluating the progress of a task and deciding what should happen next.

## Original Task
${task}
${planSection}

## Execution History
${formatExecutionHistory(history)}

## Last Execution
${formatLastExecution(lastExecution)}
${constraintsSection}
${transitionSection}

## Instructions

Based on the progress so far, decide what should happen next:

1. **COMPLETE** - The task has been successfully completed. ${currentAgent?.transitions?.onSuccess === "complete" ? "The current agent is configured to complete on success." : "Only choose this if the entire task pipeline is finished."}
2. **CONTINUE** - The current approach is working, continue with the plan
3. **SELECT_MODE** - Switch to a different agent. ${currentAgent?.transitions?.onSuccess && currentAgent.transitions.onSuccess !== "complete" ? `The current agent is configured to transition to "${currentAgent.transitions.onSuccess}" on success.` : ""}
4. **RETRY** - The last attempt failed, try a different approach

**IMPORTANT**: If the current agent has configured transitions (shown above), you should generally follow them unless there's a specific reason not to (e.g., unexpected failure, missing requirements).

Respond with a JSON object in one of these formats:

For COMPLETE:
\`\`\`json
{
  "type": "COMPLETE",
  "summary": "<summary of what was accomplished>"
}
\`\`\`

For CONTINUE:
\`\`\`json
{
  "type": "CONTINUE",
  "reason": "<why we should continue>"
}
\`\`\`

For SELECT_MODE:
\`\`\`json
{
  "type": "SELECT_MODE",
  "mode": "<agent_name>",
  "reason": "<why this agent should take over>"
}
\`\`\`

For RETRY:
\`\`\`json
{
  "type": "RETRY",
  "reason": "<what went wrong and what to try differently>"
}
\`\`\``;
}

function formatPlan(plan: Plan): string {
  return plan.steps
    .map((step) => {
      const status = step.index === plan.currentStepIndex ? "→" :
                     step.status === "complete" ? "✓" :
                     step.status === "failed" ? "✗" : " ";
      return `${status} ${step.index + 1}. [${step.status}] ${step.description}`;
    })
    .join("\n");
}

function formatExecutionHistory(history: ExecutionSummary[]): string {
  if (history.length === 0) return "No previous executions.";

  return history
    .map((entry) => {
      const duration = `(${(entry.durationMs / 1000).toFixed(1)}s)`;
      const errorInfo = entry.error ? ` [Error: ${entry.error.message}]` : "";
      const outputInfo = entry.output?.summary
        ? `\n   Output: ${entry.output.summary.substring(0, 150)}${entry.output.summary.length > 150 ? "..." : ""}`
        : "";
      const filesInfo = entry.output?.filesModified?.length
        ? `\n   Files: ${entry.output.filesModified.join(", ")}`
        : "";
      return `${entry.iteration}. ${entry.agent} - ${entry.status} ${duration}${errorInfo}${outputInfo}${filesInfo}`;
    })
    .join("\n\n");
}

function formatAgentDescriptions(agents: AgentDescription[]): string {
  return agents
    .map((a) => {
      const toolInfo = a.tools?.allowed
        ? `\n   Tools: ${a.tools.allowed.join(", ")}`
        : "";
      return `- **${a.name}** (${a.displayName}): ${a.whenToUse ?? "No description provided"}${toolInfo}`;
    })
    .join("\n");
}

function formatErrorContext(error: ErrorContext): string {
  let formatted = `**Error**: ${error.message}\n`;
  formatted += `- Category: ${error.category}\n`;
  formatted += `- Agent: ${error.agent}\n`;
  if (error.tool) {
    formatted += `- Tool: ${error.tool}\n`;
  }
  if (error.planStep !== undefined) {
    formatted += `- Plan Step: ${error.planStep + 1}\n`;
  }
  formatted += `- Attempted: ${error.attempted}\n`;

  if (error.recoveryOptions.length > 0) {
    formatted += `\n**Recovery Options**:\n`;
    for (const option of error.recoveryOptions) {
      formatted += `- ${option.action}: ${option.description} (${option.reason})\n`;
    }
  }

  return formatted;
}

function formatConstraints(constraints: ConstraintContext): string {
  const lines: string[] = [];
  lines.push(`- Iteration: ${constraints.currentIteration}/${constraints.maxIterations} (${constraints.iterationsRemaining} remaining)`);
  lines.push(`- Consecutive Failures: ${constraints.consecutiveFailures}/${constraints.maxConsecutiveFailures}`);
  if (constraints.estimatedTokensUsed) {
    lines.push(`- Estimated Tokens Used: ${constraints.estimatedTokensUsed}`);
  }
  if (constraints.timeElapsedMs) {
    const seconds = (constraints.timeElapsedMs / 1000).toFixed(1);
    lines.push(`- Time Elapsed: ${seconds}s`);
  }
  return lines.join("\n");
}

function formatLastExecution(execution: ExecutionSummary): string {
  let formatted = `- Agent: ${execution.agent}\n`;
  formatted += `- Result: ${execution.status}\n`;
  formatted += `- Duration: ${(execution.durationMs / 1000).toFixed(1)}s\n`;

  if (execution.output?.summary) {
    formatted += `- Output: ${execution.output.summary}\n`;
  }
  if (execution.output?.filesModified?.length) {
    formatted += `- Files Modified: ${execution.output.filesModified.join(", ")}\n`;
  }
  if (execution.error) {
    formatted += `- Error: ${execution.error.message}\n`;
  }
  if (execution.tokens) {
    formatted += `- Tokens: ${execution.tokens.inputTokens || 0} in / ${execution.tokens.outputTokens || 0} out\n`;
  }

  return formatted;
}

function formatTransitions(agent: AgentDefinition): string {
  const { transitions } = agent;
  const lines: string[] = [];

  lines.push(`Current agent: **${agent.name}**`);

  if (transitions.onSuccess) {
    lines.push(`- On Success: → **${transitions.onSuccess}**`);
  }
  if (transitions.onFailure) {
    lines.push(`- On Failure: → **${transitions.onFailure}**`);
  }
  if (transitions.onMaxIterations) {
    lines.push(`- On Max Iterations: → **${transitions.onMaxIterations}**`);
  }
  // Custom transitions now use predicate functions - show target and reason
  if ("custom" in transitions && transitions.custom) {
    for (const custom of transitions.custom as Array<{ target: string; reason: string }>) {
      lines.push(`- Custom: → **${custom.target}** (${custom.reason})`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Plan Generation Prompt
// ============================================================================

/**
 * Build the prompt for generating an execution plan.
 * The LLM will return a structured ExecutionPlan using native SDK structured outputs.
 */
export function buildGeneratePlanPrompt(input: GeneratePlanInput): string {
  const { task, memories, agents } = input;

  const agentsSection = formatAgentsForPlan(agents);
  const memoriesSection = formatMemoriesForPlan(memories);

  return `# Execution Plan Generation

You are a planning arbiter. Your job is to analyze the user's task and create a structured execution plan that orchestrates the available agents to accomplish the goal.

## User Task
${task}

## Available Agents
${agentsSection}

${memoriesSection}

## Instructions

Analyze the task and create an execution plan that:
1. Breaks down the task into discrete steps
2. Assigns the most appropriate agent to each step based on their capabilities
3. Considers dependencies between steps
4. Accounts for any relevant memories or past learnings
5. Estimates the overall complexity (1-10 scale)

For each step, specify:
- Which agent should execute it
- What the objective is for that step
- What context/inputs the agent needs
- What outputs are expected
- Why this agent was chosen (rationale)
- Which previous steps it depends on (if any)

Return a plan that accomplishes the user's task efficiently while respecting agent capabilities and transitions.`;
}

/**
 * Format agents for the plan generation prompt
 */
function formatAgentsForPlan(agents: Map<string, AgentDefinition>): string {
  const lines: string[] = [];

  for (const [name, agent] of agents) {
    lines.push(`### ${name}${agent.displayName ? ` (${agent.displayName})` : ""}`);

    if (agent.whenToUse) {
      lines.push(`**When to use:** ${agent.whenToUse}`);
    }

    if (agent.tools) {
      if (agent.tools.allowed?.length) {
        lines.push(`**Tools:** ${agent.tools.allowed.join(", ")}`);
      }
      if (agent.tools.blocked?.length) {
        lines.push(`**Blocked tools:** ${agent.tools.blocked.join(", ")}`);
      }
    }

    lines.push(`**Transitions:**`);
    if (agent.transitions.onSuccess) {
      lines.push(`  - On success: → ${agent.transitions.onSuccess}`);
    }
    if (agent.transitions.onFailure) {
      lines.push(`  - On failure: → ${agent.transitions.onFailure}`);
    }
    // Custom transitions now use predicate functions - show target and reason
    if ("custom" in agent.transitions && agent.transitions.custom) {
      for (const custom of agent.transitions.custom as Array<{ target: string; reason: string }>) {
        lines.push(`  - Custom: → ${custom.target} (${custom.reason})`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format memories for the plan generation prompt
 */
function formatMemoriesForPlan(memories: MemoryMetadata[]): string {
  if (memories.length === 0) {
    return "";
  }

  const lines: string[] = ["## Relevant Memories", ""];

  for (const memory of memories) {
    const { frontmatter, filename } = memory;
    lines.push(`### ${frontmatter.title}`);
    lines.push(`- **File:** ${filename}`);
    lines.push(`- **Importance:** ${frontmatter.importance}`);
    lines.push(`- **Tags:** ${frontmatter.tags.join(", ")}`);

    const whenToUse = Array.isArray(frontmatter.whenToUse)
      ? frontmatter.whenToUse.join("; ")
      : frontmatter.whenToUse;
    lines.push(`- **When to use:** ${whenToUse}`);
    lines.push("");
  }

  return lines.join("\n");
}
