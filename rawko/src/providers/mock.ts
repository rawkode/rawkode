/**
 * Mock provider for testing
 */

import type { z } from "zod";
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

export interface MockResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
}

export interface MockStructuredResponse {
  data: unknown;
}

export class MockProvider implements Provider {
  readonly name = "mock";
  readonly displayName = "Mock Provider";

  private responses: MockResponse[] = [];
  private responseIndex = 0;
  private structuredResponses: MockStructuredResponse[] = [];
  private structuredIndex = 0;

  constructor(responses: MockResponse[] = []) {
    this.responses = responses;
  }

  addResponse(response: MockResponse): void {
    this.responses.push(response);
  }

  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  addStructuredResponse(response: MockStructuredResponse): void {
    this.structuredResponses.push(response);
  }

  setStructuredResponses(responses: MockStructuredResponse[]): void {
    this.structuredResponses = responses;
    this.structuredIndex = 0;
  }

  async createSession(config: SessionConfig): Promise<ProviderSession> {
    return new MockSession(this, config);
  }

  async validate(): Promise<boolean> {
    return true;
  }

  getNextResponse(): MockResponse {
    if (this.responseIndex >= this.responses.length) {
      return {
        content: "No more mock responses available",
        stopReason: "end_turn",
      };
    }
    return this.responses[this.responseIndex++];
  }

  getNextStructuredResponse(): MockStructuredResponse | null {
    if (this.structuredIndex >= this.structuredResponses.length) {
      return null;
    }
    return this.structuredResponses[this.structuredIndex++];
  }

  resetResponses(): void {
    this.responseIndex = 0;
    this.structuredIndex = 0;
  }
}

class MockSession implements ProviderSession {
  readonly id: string;
  readonly provider = "mock";
  readonly model: string;

  private history: Message[] = [];
  private tools: ToolDefinition[] = [];
  private systemPrompt: string;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(
    private mockProvider: MockProvider,
    config: SessionConfig,
  ) {
    this.id = config.sessionId ?? crypto.randomUUID();
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? "";
    this.tools = config.tools ?? [];
  }

  async *sendMessage(message: Message): AsyncIterable<StreamEvent> {
    this.history.push(message);

    const response = this.mockProvider.getNextResponse();

    // Simulate streaming text
    if (response.content) {
      const words = response.content.split(" ");
      for (const word of words) {
        yield { type: "text_delta", delta: word + " " };
        await delay(10); // Simulate network latency
      }
    }

    // Simulate tool calls
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield { type: "tool_use_start", id: tc.id, name: tc.name };
        yield {
          type: "tool_use_end",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        };
      }
    }

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    };

    this.history.push(assistantMessage);

    // Update usage
    this.usage.inputTokens += estimateTokens(message);
    this.usage.outputTokens += estimateTokens(assistantMessage);
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;

    yield {
      type: "message_done",
      message: assistantMessage,
      usage: { ...this.usage },
      stopReason: response.stopReason ?? (response.toolCalls ? "tool_use" : "end_turn"),
    };
  }

  /**
   * Query with structured output using Zod schema validation.
   * For mock provider, returns the next structured response from the queue.
   */
  async queryStructured<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T> {
    // Get next structured response from mock provider
    const response = this.mockProvider.getNextStructuredResponse();

    if (!response) {
      throw new ProviderError(
        "No more mock structured responses available",
        "mock",
        "invalid_request",
      );
    }

    // Validate against schema
    try {
      const validated = schema.parse(response.data);
      return validated;
    } catch (error) {
      const err = error as Error;
      throw new ProviderError(
        `Mock structured response failed validation: ${err.message}`,
        "mock",
        "invalid_request",
        err,
      );
    }
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
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  async close(): Promise<void> {
    // Nothing to clean up
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(message: Message): number {
  const content =
    message.role === "assistant" ? message.content : "content" in message ? String(message.content) : "";
  return Math.ceil(content.length / 4);
}
