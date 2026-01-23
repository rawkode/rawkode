/**
 * Arbiter - LLM-based decision maker for agent transitions
 *
 * Supports predicate-based custom transitions for structured agents.
 * Falls back to LLM query when no custom transition matches.
 */

import type { ArbiterConfig } from "../config/types.ts";
import type { Provider, ProviderSession } from "../providers/types.ts";
import type {
  AgentDefinition,
  StructuredAgent,
  CustomTransition,
} from "../config/typescript-config.ts";
import { isStructuredAgent } from "../config/typescript-config.ts";
import { ProviderFactory } from "../providers/factory.ts";
import type {
  ArbiterDecision,
  SelectAgentInput,
  EvaluateProgressInput,
  GeneratePlanInput,
  GeneratePlanOutput,
  ExecutionPlan,
} from "./types.ts";
import { ExecutionPlanSchema } from "./types.ts";
import { buildSelectAgentPrompt, buildEvaluateProgressPrompt } from "./prompts.ts";

/**
 * Extended input for evaluateProgress that includes current agent config
 * and structured output from the execution.
 */
export interface EvaluateProgressWithAgentInput extends EvaluateProgressInput {
  currentAgent?: AgentDefinition;
  /** Structured output from the agent execution (if agent has responseSchema) */
  structuredOutput?: unknown;
}

export interface ArbiterOptions {
  config: ArbiterConfig;
  provider?: Provider;
}

export class Arbiter {
  private config: ArbiterConfig;
  private provider: Provider;
  private session: ProviderSession | null = null;

  constructor(options: ArbiterOptions) {
    this.config = options.config;
    this.provider = options.provider ?? ProviderFactory.get(options.config.provider);
  }

  /**
   * Generate an execution plan for the given task.
   * Uses structured output with Zod schema validation.
   */
  async generatePlan(input: GeneratePlanInput): Promise<GeneratePlanOutput> {
    const prompt = this.buildGeneratePlanPrompt(input);

    // Create a session if we don't have one
    if (!this.session) {
      this.session = await this.provider.createSession({
        model: this.config.model,
        maxTokens: this.config.maxTokens ?? 4096,
        temperature: this.config.temperature ?? 0.3,
        systemPrompt:
          "You are an execution planner. Analyze tasks and create structured execution plans. Always respond with valid JSON matching the required schema.",
      });
    }

    // Use structured output with Zod schema
    const response = await this.session.queryStructured(prompt, ExecutionPlanSchema);

    // Build the full ExecutionPlan with metadata
    const plan: ExecutionPlan = {
      ...response,
      id: crypto.randomUUID(),
      task: input.task,
      createdAt: new Date().toISOString(),
      version: 1,
    };

    return {
      plan,
      confidence: response.confidence,
      warnings: response.warnings,
    };
  }

  /**
   * Select the next agent based on current task state.
   * Uses enriched context from SPEC-0006.
   *
   * IMPORTANT: This method should ALWAYS return SELECT_MODE.
   * If the LLM returns COMPLETE or another decision type, we fall back
   * to a sensible default (developer or default agent).
   */
  async selectAgent(input: SelectAgentInput): Promise<ArbiterDecision> {
    // For initial selection with no history, use the default agent
    if (input.history.length === 0 && !input.lastError && input.defaultAgent) {
      const defaultAgent = input.availableAgents.find(
        (a) => a.name === input.defaultAgent,
      );
      if (defaultAgent) {
        return {
          type: "SELECT_MODE",
          mode: defaultAgent.name,
          reason: "Starting with default agent for new task",
        };
      }
    }

    // Check if we're close to iteration limit
    if (input.constraints.iterationsRemaining <= 2) {
      console.warn(`Warning: Only ${input.constraints.iterationsRemaining} iterations remaining`);
    }

    const prompt = buildSelectAgentPrompt(input);
    const response = await this.query(prompt);

    const decision = this.parseDecision(response);

    // selectAgent should always return SELECT_MODE
    // If LLM returned something else, fall back to developer or default agent
    if (decision.type !== "SELECT_MODE") {
      const fallbackAgent = input.availableAgents.find(
        (a) => a.name === "developer",
      ) ?? input.availableAgents.find(
        (a) => a.name === input.defaultAgent,
      ) ?? input.availableAgents[0];

      return {
        type: "SELECT_MODE",
        mode: fallbackAgent?.name ?? "developer",
        reason: `LLM returned ${decision.type}, falling back to ${fallbackAgent?.name ?? "developer"}`,
      };
    }

    return decision;
  }

  /**
   * Evaluate progress and decide next action.
   *
   * IMPORTANT: For structured agents with custom transitions, evaluates
   * predicate functions FIRST before querying the LLM. This enables
   * type-safe, deterministic transitions based on structured output.
   */
  async evaluateProgress(input: EvaluateProgressWithAgentInput): Promise<ArbiterDecision> {
    const { currentAgent, structuredOutput } = input;


    // Check if plan is complete
    if (input.plan?.status === "complete") {
      return {
        type: "COMPLETE",
        summary: "All plan steps have been completed",
      };
    }

    // Check if we've exceeded consecutive failure limit
    if (input.constraints.consecutiveFailures >= input.constraints.maxConsecutiveFailures) {
      return {
        type: "RETRY",
        reason: `Exceeded maximum consecutive failures (${input.constraints.maxConsecutiveFailures})`,
      };
    }

    // If last execution failed, check configured transition or query LLM
    if (input.lastExecution.status === "failure") {
      // Check for configured onFailure transition
      if (currentAgent?.transitions?.onFailure) {
        const target = currentAgent.transitions.onFailure;
        if (target === "complete") {
          return {
            type: "COMPLETE",
            summary: `Agent ${currentAgent.name} failed, configured to complete on failure`,
          };
        }
        return {
          type: "SELECT_MODE",
          mode: target,
          reason: `Agent ${currentAgent.name} failed, transitioning to configured onFailure target: ${target}`,
        };
      }
      // No configured transition, query LLM
      const prompt = buildEvaluateProgressPrompt(input, currentAgent);
      const response = await this.query(prompt);
      return this.parseDecision(response);
    }

    // SUCCESS CASE: Check if planner produced a valid plan
    if (currentAgent?.name === "planner" && input.lastExecution.status === "success") {
      const hasValidPlan = input.plan &&
        input.plan.steps &&
        input.plan.steps.length > 0;

      if (!hasValidPlan) {
        return {
          type: "RETRY",
          reason: "Planner succeeded but did not produce a valid plan with steps. Retry to create a proper plan.",
        };
      }
    }

    // SUCCESS CASE with STRUCTURED OUTPUT: Evaluate custom transitions FIRST
    if (
      currentAgent &&
      structuredOutput !== undefined &&
      isStructuredAgent(currentAgent) &&
      currentAgent.transitions.custom
    ) {
      const decision = this.evaluateCustomTransitions(
        currentAgent,
        structuredOutput,
      );
      if (decision) {
        return decision;
      }
    }

    // SUCCESS CASE: Respect configured onSuccess transition BEFORE querying LLM
    if (currentAgent?.transitions?.onSuccess && input.lastExecution.status === "success") {
      const target = currentAgent.transitions.onSuccess;
      // If transition target is "complete", mark as complete
      if (target === "complete") {
        return {
          type: "COMPLETE",
          summary: `Agent ${currentAgent.name} succeeded, configured transition to complete`,
        };
      }

      // Otherwise, transition to the configured next agent
      return {
        type: "SELECT_MODE",
        mode: target,
        reason: `Agent ${currentAgent.name} succeeded, transitioning to configured onSuccess target: ${target}`,
      };
    }

    // No configured transition or complex case - query LLM for decision
    const prompt = buildEvaluateProgressPrompt(input, currentAgent);
    const response = await this.query(prompt);

    return this.parseDecision(response);
  }

  /**
   * Evaluate custom predicate-based transitions for structured agents.
   * Returns a decision if a transition matches, or undefined to fall through.
   */
  private evaluateCustomTransitions<T>(
    agent: StructuredAgent<import("zod").ZodTypeAny>,
    structuredOutput: T,
  ): ArbiterDecision | undefined {
    const customTransitions = agent.transitions.custom as CustomTransition<T>[] | undefined;

    if (!customTransitions || customTransitions.length === 0) {
      return undefined;
    }

    // Evaluate each custom transition predicate in order
    for (const transition of customTransitions) {
      try {
        if (transition.when(structuredOutput)) {
          // Predicate matched - return the appropriate decision
          if (transition.target === "complete") {
            return {
              type: "COMPLETE",
              summary: transition.reason,
            };
          }
          return {
            type: "SELECT_MODE",
            mode: transition.target,
            reason: transition.reason,
          };
        }
      } catch (error) {
        // If predicate throws, log and continue to next transition
        console.warn(
          `Custom transition predicate failed for agent ${agent.name}:`,
          (error as Error).message,
        );
      }
    }

    // No custom transition matched
    return undefined;
  }

  /**
   * Build the prompt for plan generation.
   */
  private buildGeneratePlanPrompt(input: GeneratePlanInput): string {
    const agentNames = [...input.agents.keys()].join(", ");

    return `Create an execution plan for the following task:

Task: ${input.task}

Available Agents: ${agentNames}

Provide a structured plan with:
1. Analysis of the task
2. Step-by-step implementation plan
3. Confidence level (high/medium/low)
4. Any warnings or considerations

Respond with valid JSON matching the ExecutionPlan schema.`;
  }

  /**
   * Send a query to the LLM and get a response.
   */
  private async query(prompt: string): Promise<string> {
    if (!this.session) {
      this.session = await this.provider.createSession({
        model: this.config.model,
        maxTokens: this.config.maxTokens ?? 1024,
        temperature: this.config.temperature ?? 0.3,
        systemPrompt:
          "You are an arbiter that makes decisions about agent transitions. Always respond with valid JSON.",
      });
    }

    let response = "";

    for await (const event of this.session.sendMessage({
      role: "user",
      content: prompt,
    })) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
      if (event.type === "message_done") {
        response = event.message.content;
      }
    }

    return response;
  }

  /**
   * Parse the LLM response into a decision.
   */
  private parseDecision(response: string): ArbiterDecision {
    // Extract JSON from response
    const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    try {
      const decision = JSON.parse(jsonStr.trim());

      // Validate decision type
      if (!decision.type) {
        throw new Error("Missing decision type");
      }

      switch (decision.type) {
        case "SELECT_MODE":
          if (!decision.mode) {
            throw new Error("SELECT_MODE requires a mode");
          }
          return {
            type: "SELECT_MODE",
            mode: decision.mode,
            reason: decision.reason ?? "No reason provided",
          };

        case "CONTINUE":
          return {
            type: "CONTINUE",
            reason: decision.reason ?? "Continuing with current approach",
          };

        case "COMPLETE":
          return {
            type: "COMPLETE",
            summary: decision.summary ?? "Task completed",
          };

        case "RETRY":
          return {
            type: "RETRY",
            reason: decision.reason ?? "Retrying with different approach",
          };

        default:
          throw new Error(`Unknown decision type: ${decision.type}`);
      }
    } catch (error) {
      // Fallback: try to infer intent from response
      console.warn("Failed to parse arbiter response:", (error as Error).message);

      if (response.toLowerCase().includes("complete")) {
        return {
          type: "COMPLETE",
          summary: "Task appears to be complete based on arbiter response",
        };
      }

      // Default to continuing
      return {
        type: "CONTINUE",
        reason: "Could not parse arbiter response, defaulting to continue",
      };
    }
  }

  /**
   * Close the arbiter session.
   */
  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}
