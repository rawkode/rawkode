/**
 * GitHub Copilot provider using Copilot SDK
 *
 * The Copilot SDK spawns Copilot CLI as a subprocess and handles:
 * - Authentication (uses GitHub/Copilot stored credentials)
 * - Tool execution (executes tools internally)
 * - The agent loop (multiple turns until completion)
 */

import {
  CopilotClient,
  CopilotSession,
  defineTool,
} from "@github/copilot-sdk";
import type {
  SessionEvent,
  Tool,
} from "@github/copilot-sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "npm:zod-to-json-schema@3.23.0";
import type { ToolDefinition } from "../tools/types.ts";
import type {
  Provider,
  ProviderSession,
  SessionConfig,
  Message,
  AssistantMessage,
  StreamEvent,
  TokenUsage,
} from "./types.ts";
import { ProviderError } from "./types.ts";

// Singleton client - shared across sessions
let sharedClient: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
  if (!sharedClient) {
    sharedClient = new CopilotClient({
      autoStart: true,
      autoRestart: true,
    });
    await sharedClient.start();
  }
  return sharedClient;
}

export class CopilotProvider implements Provider {
  readonly name = "copilot";
  readonly displayName = "GitHub Copilot (SDK)";

  async createSession(config: SessionConfig): Promise<ProviderSession> {
    const client = await getClient();
    return new CopilotAgentSession(client, config);
  }

  async validate(): Promise<boolean> {
    // Copilot SDK handles auth through GitHub CLI
    return true;
  }
}

class CopilotAgentSession implements ProviderSession {
  readonly id: string;
  readonly provider = "copilot";
  readonly model: string;

  private client: CopilotClient;
  private session: CopilotSession | null = null;
  private history: Message[] = [];
  private tools: ToolDefinition[] = [];
  private systemPrompt: string;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(client: CopilotClient, config: SessionConfig) {
    this.client = client;
    this.id = config.sessionId ?? crypto.randomUUID();
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? "";
    this.tools = config.tools ?? [];
  }

  async *sendMessage(message: Message): AsyncIterable<StreamEvent> {
    this.history.push(message);

    try {
      // Create session if not exists
      if (!this.session) {
        this.session = await this.client.createSession({
          sessionId: this.id,
          model: this.model,
          streaming: true,
          systemMessage: this.systemPrompt
            ? { mode: "append", content: this.systemPrompt }
            : undefined,
          tools: this.tools.map((t) => this.toSdkTool(t)),
        });
      }

      const prompt = message.role === "user" ? message.content : "";
      let fullContent = "";

      // Collect events through event handler
      const events: StreamEvent[] = [];
      let resolveIdle: () => void;
      const idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });

      const unsubscribe = this.session.on((event: SessionEvent) => {
        const mappedEvents = this.mapSessionEvent(event);
        for (const e of mappedEvents) {
          events.push(e);
          if (e.type === "text_delta") {
            fullContent += e.delta;
          }
        }
        if (event.type === "session.idle") {
          resolveIdle();
        }
      });

      // Send message
      await this.session.send({ prompt });

      // Wait for completion
      await idlePromise;
      unsubscribe();

      // Yield all collected events
      for (const event of events) {
        yield event;
      }

      // Build final assistant message
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: fullContent,
      };
      this.history.push(assistantMessage);

      yield {
        type: "message_done",
        message: assistantMessage,
        usage: { ...this.usage },
        stopReason: "end_turn",
      };
    } catch (error) {
      const err = error as Error;
      yield {
        type: "error",
        error: new ProviderError(
          err.message,
          "copilot",
          categorizeError(err),
          err,
        ),
      };
    }
  }

  /**
   * Query with structured output using Zod schema validation.
   */
  async queryStructured<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T> {
    // Convert Zod schema to JSON Schema
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });

    // Build structured prompt
    const structuredPrompt = `${prompt}

## Output Format

You must respond with a JSON object that matches this schema:

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`

Respond ONLY with valid JSON. Do not include any other text, markdown formatting, or code blocks.`;

    // Create a temporary session for structured output
    const session = await this.client.createSession({
      sessionId: crypto.randomUUID(),
      model: this.model,
      streaming: true,
      systemMessage: {
        mode: "append",
        content: "You are a helpful assistant that responds with valid JSON.",
      },
      tools: [], // No tools for structured output
    });

    try {
      let fullContent = "";
      let resolveIdle: () => void;
      const idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });

      const unsubscribe = session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta" && event.data.deltaContent) {
          fullContent += event.data.deltaContent;
        }
        if (event.type === "session.idle") {
          resolveIdle();
        }
      });

      await session.send({ prompt: structuredPrompt });
      await idlePromise;
      unsubscribe();

      // Parse and validate the response
      let jsonStr = fullContent.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);
      const validated = schema.parse(parsed);
      return validated;
    } catch (error) {
      const err = error as Error;
      throw new ProviderError(
        `Failed to parse structured output: ${err.message}`,
        "copilot",
        "invalid_request",
        err,
      );
    } finally {
      await session.destroy();
    }
  }

  private toSdkTool(tool: ToolDefinition): Tool {
    return defineTool(tool.name, {
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
      handler: async (args: unknown) => {
        if (tool.handler) {
          const result = await tool.handler(args);
          if (result.isError) {
            return { textResultForLlm: result.output, resultType: "failure" as const };
          }
          return result.output;
        }
        return `Tool ${tool.name} executed with input: ${JSON.stringify(args)}`;
      },
    });
  }

  private mapSessionEvent(event: SessionEvent): StreamEvent[] {
    const events: StreamEvent[] = [];

    switch (event.type) {
      case "assistant.message_delta":
        if (event.data.deltaContent) {
          events.push({ type: "text_delta", delta: event.data.deltaContent });
        }
        break;

      case "assistant.message":
        // Final message - already handled via streaming deltas
        break;

      case "tool.execution_start":
        events.push({
          type: "tool_use_start",
          id: event.data.toolCallId,
          name: event.data.toolName,
        });
        break;

      case "tool.execution_complete":
        events.push({
          type: "tool_use_end",
          id: event.data.toolCallId,
          name: event.data.toolCallId, // toolName not available in complete event
          input: undefined,
        });
        events.push({
          type: "tool_result",
          id: event.data.toolCallId,
          output: event.data.result?.content ?? "",
          isError: !event.data.success,
        });
        break;

      case "session.error":
        events.push({
          type: "error",
          error: new ProviderError(
            event.data.message || "Unknown session error",
            "copilot",
            "unknown",
          ),
        });
        break;

      default:
        // Other events we don't need to handle
        break;
    }

    return events;
  }

  setTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    // Note: Tools are set at session creation, so changing them mid-session
    // would require creating a new session
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
    this.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.destroy();
      this.session = null;
    }
    this.history = [];
  }
}

function categorizeError(error: Error): ProviderError["code"] {
  const message = error.message.toLowerCase();

  if (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("401")
  ) {
    return "authentication_failed";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate_limited";
  }
  if (
    message.includes("context") ||
    message.includes("token") ||
    message.includes("length")
  ) {
    return "context_length_exceeded";
  }
  if (message.includes("model")) {
    return "model_unavailable";
  }
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("connect") ||
    message.includes("fetch")
  ) {
    return "network_error";
  }

  return "unknown";
}
