/**
 * Claude provider using Claude Agent SDK
 *
 * The Agent SDK spawns Claude Code as a subprocess and handles:
 * - Authentication (uses Claude Code's stored credentials)
 * - Tool execution (executes tools internally)
 * - The agent loop (multiple turns until completion)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as AgentOptions,
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
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

export class ClaudeProvider implements Provider {
  readonly name = "claude";
  readonly displayName = "Anthropic Claude (Agent SDK)";

  async createSession(config: SessionConfig): Promise<ProviderSession> {
    return new ClaudeAgentSession(config);
  }

  async validate(): Promise<boolean> {
    // Agent SDK handles auth through Claude Code
    return true;
  }
}

class ClaudeAgentSession implements ProviderSession {
  readonly id: string;
  readonly provider = "claude";
  readonly model: string;

  private history: Message[] = [];
  private tools: ToolDefinition[] = [];
  private systemPrompt: string;
  private maxTokens: number;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: SessionConfig) {
    this.id = config.sessionId ?? crypto.randomUUID();
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? "";
    this.tools = config.tools ?? [];
    this.maxTokens = config.maxTokens ?? 8192;
  }

  async *sendMessage(message: Message): AsyncIterable<StreamEvent> {
    this.history.push(message);

    try {
      // Build the prompt from the message
      const prompt = message.role === "user" ? message.content : "";

      // Configure Agent SDK options
      const options: AgentOptions = {
        model: this.model,
        systemPrompt: this.systemPrompt || undefined,
        maxTurns: 20,
        // Map rawko tools to SDK tool names
        tools: this.tools.length > 0
          ? this.tools.map((t) => t.name)
          : undefined,
        // Allow all configured tools
        allowedTools: this.tools.map((t) => t.name),
        // Include partial messages for streaming
        includePartialMessages: true,
      };

      // Run the query - SDK handles the full agent loop
      const agentQuery = query({ prompt, options });

      let fullContent = "";
      let lastAssistantMessage: SDKAssistantMessage | undefined;

      for await (const sdkMessage of agentQuery) {
        const events = this.mapSDKMessage(sdkMessage);
        for (const event of events) {
          // Accumulate text content
          if (event.type === "text_delta") {
            fullContent += event.delta;
          }
          // Track assistant messages
          if (
            sdkMessage.type === "assistant" &&
            "message" in sdkMessage
          ) {
            lastAssistantMessage = sdkMessage as SDKAssistantMessage;
          }
          yield event;
        }
      }

      // Build final assistant message
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: fullContent,
      };
      this.history.push(assistantMessage);

      // Get usage from last assistant message if available
      if (lastAssistantMessage?.message?.usage) {
        const usage = lastAssistantMessage.message.usage;
        this.usage.inputTokens += usage.input_tokens ?? 0;
        this.usage.outputTokens += usage.output_tokens ?? 0;
        this.usage.totalTokens =
          this.usage.inputTokens + this.usage.outputTokens;
      }

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
          "claude",
          categorizeError(err),
          err,
        ),
      };
    }
  }

  /**
   * Query with structured output using Zod schema validation.
   * Uses JSON schema extraction for the LLM to produce validated output.
   */
  async queryStructured<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T> {
    // Convert Zod schema to JSON Schema for the prompt
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });

    // Build a prompt that requests JSON output matching the schema
    const structuredPrompt = `${prompt}

## Output Format

You must respond with a JSON object that matches this schema:

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`

Respond ONLY with valid JSON. Do not include any other text, markdown formatting, or code blocks.`;

    // Use the agent query to get the response
    const options: AgentOptions = {
      model: this.model,
      systemPrompt: this.systemPrompt || "You are a helpful assistant that responds with valid JSON.",
      maxTurns: 1,
      // No tools for structured output queries
      tools: [],
    };

    const agentQuery = query({ prompt: structuredPrompt, options });

    let fullContent = "";
    let lastAssistantMessage: SDKAssistantMessage | undefined;

    for await (const sdkMessage of agentQuery) {
      if (sdkMessage.type === "assistant" && "message" in sdkMessage) {
        lastAssistantMessage = sdkMessage as SDKAssistantMessage;
        for (const block of lastAssistantMessage.message.content) {
          if (block.type === "text") {
            fullContent += block.text;
          }
        }
      }
    }

    // Update usage tracking
    if (lastAssistantMessage?.message?.usage) {
      const usage = lastAssistantMessage.message.usage;
      this.usage.inputTokens += usage.input_tokens ?? 0;
      this.usage.outputTokens += usage.output_tokens ?? 0;
      this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    }

    // Parse and validate the JSON response
    try {
      // Extract JSON from potential markdown code blocks
      let jsonStr = fullContent.trim();

      // Try to extract from markdown code block if present
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
        `Failed to parse structured output: ${err.message}. Raw response: ${fullContent.substring(0, 500)}`,
        "claude",
        "invalid_request",
        err,
      );
    }
  }

  private mapSDKMessage(sdkMessage: SDKMessage): StreamEvent[] {
    const events: StreamEvent[] = [];

    switch (sdkMessage.type) {
      case "assistant": {
        const msg = sdkMessage as SDKAssistantMessage;
        // Extract text from content blocks
        for (const block of msg.message.content) {
          if (block.type === "text") {
            events.push({ type: "text_delta", delta: block.text });
          } else if (block.type === "tool_use") {
            events.push({
              type: "tool_use_start",
              id: block.id,
              name: block.name,
            });
            events.push({
              type: "tool_use_end",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        break;
      }

      case "stream_event": {
        // Partial streaming events
        const event = (sdkMessage as { event: { type: string; delta?: { type: string; text?: string } } }).event;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          events.push({ type: "text_delta", delta: event.delta.text });
        }
        break;
      }

      case "result": {
        const result = sdkMessage as SDKResultMessage;
        if (result.subtype === "success") {
          // Update usage from result
          if (result.usage) {
            this.usage.inputTokens = result.usage.input_tokens;
            this.usage.outputTokens = result.usage.output_tokens;
            this.usage.totalTokens =
              this.usage.inputTokens + this.usage.outputTokens;
          }
        } else {
          // Error result
          events.push({
            type: "error",
            error: new ProviderError(
              result.errors?.join(", ") || "Unknown error",
              "claude",
              "unknown",
            ),
          });
        }
        break;
      }

      case "system": {
        // System messages (hook progress, etc.) - ignore for now
        break;
      }

      default:
        // Other message types we don't need to handle
        break;
    }

    return events;
  }

  setTools(tools: ToolDefinition[]): void {
    this.tools = tools;
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
  if (message.includes("context") || message.includes("token")) {
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
