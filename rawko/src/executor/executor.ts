/**
 * Agent Executor - Runs agents with their configured tools
 *
 * Supports both structured and free-form agent output:
 * - Structured agents: Use queryStructured() with Zod schema validation
 * - Free-form agents: Use sendMessage() for streaming text output
 */

import type {
  ProviderSession,
  Message,
  TokenUsage,
} from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Plan } from "../arbiter/types.ts";
import type { AgentDefinition } from "../config/typescript-config.ts";
import { isStructuredAgent } from "../config/typescript-config.ts";
import { buildAgentPromptWithMemories } from "../memory/injection.ts";

export interface ExecutionInput {
  agent: AgentDefinition;
  session: ProviderSession;
  task: string;
  plan: Plan | null;
  messages: Message[];
  toolRegistry: ToolRegistry;
}

export interface ExecutionResult<T = unknown> {
  success: boolean;
  output: string;
  /** Typed structured output for agents with response schemas */
  structuredOutput?: T;
  messages: Message[];
  usage: TokenUsage;
  planUpdates?: Partial<Plan>;
}

export type ExecutionEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; output: string; isError: boolean }
  | { type: "complete"; result: ExecutionResult }
  | { type: "error"; error: Error };

export class AgentExecutor {
  /**
   * Execute an agent until completion.
   *
   * For structured agents: Uses queryStructured() for validated output.
   * For free-form agents: Uses sendMessage() with streaming.
   */
  async *execute(input: ExecutionInput): AsyncGenerator<ExecutionEvent> {
    const { agent, session, task, plan, toolRegistry } = input;

    // Build system prompt with memory injection
    const systemPrompt = await buildAgentPromptWithMemories(
      agent.systemPrompt,
      {
        task,
        agentName: agent.name,
        agentDisplayName: agent.displayName,
        currentPlan: plan ? JSON.stringify(plan) : undefined,
      },
      {
        maxMemories: 5,
        minImportance: "low",
      },
    );

    // Configure session with enhanced system prompt and tools
    session.setSystemPrompt(systemPrompt);

    // Get filtered tools with handlers from the registry
    const filteredTools = toolRegistry.getToolsForAgent(agent);
    session.setTools(filteredTools);

    const messages: Message[] = [...input.messages];

    // Build the initial user message
    const userMessage = this.buildUserMessage(task, plan);
    messages.push(userMessage);

    // Check if this agent uses structured output
    if (isStructuredAgent(agent)) {
      yield* this.executeStructured(agent, session, userMessage, messages);
    } else {
      yield* this.executeFreeForm(session, userMessage, messages);
    }
  }

  /**
   * Execute a structured agent using normal tool execution,
   * then validate the final response against the Zod schema.
   *
   * Structured agents can still use tools - the schema validates
   * their final text response after tool execution completes.
   */
  private async *executeStructured(
    agent: AgentDefinition,
    session: ProviderSession,
    userMessage: Message,
    messages: Message[],
  ): AsyncGenerator<ExecutionEvent> {
    // Type assertion since we know this is a structured agent (called after isStructuredAgent check)
    const structuredAgent = agent as { responseSchema: import("zod").ZodTypeAny } & AgentDefinition;

    let lastOutput = "";
    let finalUsage = session.getUsage();

    try {
      // Use normal sendMessage with tool execution
      for await (const event of session.sendMessage(userMessage)) {
        switch (event.type) {
          case "text_delta":
            yield { type: "text", content: event.delta };
            break;

          case "tool_use_start":
            // Tool execution starting
            break;

          case "tool_use_end":
            yield { type: "tool_call", name: event.name, input: event.input };
            break;

          case "tool_result":
            yield {
              type: "tool_result",
              output: event.output,
              isError: event.isError,
            };
            break;

          case "error":
            yield { type: "error", error: event.error };
            return;

          case "message_done":
            messages.push(event.message);
            lastOutput = event.message.content;
            finalUsage = event.usage;
            break;
        }
      }

      // Try to parse the final output as structured JSON
      let structuredOutput: unknown = undefined;
      try {
        // Extract JSON from the output (may be wrapped in markdown code blocks)
        const jsonMatch = lastOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : lastOutput.trim();

        const parsed = JSON.parse(jsonStr);
        const validated = structuredAgent.responseSchema.safeParse(parsed);

        if (validated.success) {
          structuredOutput = validated.data;
          // Use the validated JSON as the canonical output
          lastOutput = JSON.stringify(structuredOutput, null, 2);
        } else {
          console.warn(
            `[${structuredAgent.name}] Output did not match schema:`,
            validated.error.message
          );
        }
      } catch {
        // Output is not valid JSON - that's okay for free-form responses
        // The structuredOutput will remain undefined
        console.warn(
          `[${structuredAgent.name}] Output is not valid JSON, treating as free-form`
        );
      }

      yield {
        type: "complete",
        result: {
          success: true,
          output: lastOutput || "Task completed",
          structuredOutput,
          messages,
          usage: finalUsage,
        },
      };
    } catch (error) {
      yield { type: "error", error: error as Error };
    }
  }

  /**
   * Execute a free-form agent using sendMessage() with streaming.
   * This is the original execution path for agents without response schemas.
   */
  private async *executeFreeForm(
    session: ProviderSession,
    userMessage: Message,
    messages: Message[],
  ): AsyncGenerator<ExecutionEvent> {
    let lastOutput = "";
    let finalUsage: TokenUsage = session.getUsage();

    try {
      // Send message - for Claude, the SDK handles the full agent loop
      for await (const event of session.sendMessage(userMessage)) {
        switch (event.type) {
          case "text_delta":
            yield { type: "text", content: event.delta };
            break;

          case "tool_use_start":
            // Tool execution starting (SDK handles this for Claude)
            break;

          case "tool_use_end":
            yield { type: "tool_call", name: event.name, input: event.input };
            break;

          case "tool_result":
            yield {
              type: "tool_result",
              output: event.output,
              isError: event.isError,
            };
            break;

          case "error":
            yield { type: "error", error: event.error };
            return;

          case "message_done":
            messages.push(event.message);
            lastOutput = event.message.content;
            finalUsage = event.usage;

            // Agent completed
            yield {
              type: "complete",
              result: {
                success: true,
                output: lastOutput,
                messages,
                usage: finalUsage,
              },
            };
            return;
        }
      }

      // If we get here without a message_done, yield completion
      yield {
        type: "complete",
        result: {
          success: true,
          output: lastOutput || "Task completed",
          messages,
          usage: finalUsage,
        },
      };
    } catch (error) {
      yield { type: "error", error: error as Error };
    }
  }

  private buildUserMessage(task: string, plan: Plan | null): Message {
    let content = `Task: ${task}`;

    if (plan) {
      const currentStep = plan.steps[plan.currentStepIndex];
      if (currentStep) {
        content +=
          `\n\nCurrent plan step (${plan.currentStepIndex + 1}/${plan.steps.length}): ${currentStep.description}`;
      }
    }

    return { role: "user", content };
  }
}
