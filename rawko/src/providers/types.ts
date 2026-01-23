/**
 * Provider types for rawko-sdk
 */

import type { z } from "zod";
import type { ToolDefinition } from "../tools/types.ts";

export interface SessionConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  sessionId?: string;
}

export interface Provider {
  readonly name: string;
  readonly displayName: string;
  createSession(config: SessionConfig): Promise<ProviderSession>;
  validate(): Promise<boolean>;
}

export interface ProviderSession {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  sendMessage(message: Message): AsyncIterable<StreamEvent>;
  /**
   * Query the LLM with structured output validation using a Zod schema.
   * The LLM response will be validated against the schema and returned as typed data.
   */
  queryStructured<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T>;
  setTools(tools: ToolDefinition[]): void;
  setSystemPrompt(prompt: string): void;
  getHistory(): Message[];
  clearHistory(): void;
  getUsage(): TokenUsage;
  close(): Promise<void>;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseInputEvent
  | ToolUseEndEvent
  | ToolResultEvent
  | MessageDoneEvent
  | ErrorEvent;

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
}

export interface ToolUseInputEvent {
  type: "tool_use_input";
  id: string;
  delta: string;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  output: string;
  isError: boolean;
}

export interface MessageDoneEvent {
  type: "message_done";
  message: AssistantMessage;
  usage: TokenUsage;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface ErrorEvent {
  type: "error";
  error: ProviderError;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ProviderErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "context_length_exceeded"
  | "invalid_request"
  | "model_unavailable"
  | "network_error"
  | "unknown";

export class ProviderError extends Error {
  public readonly provider: string;
  public readonly code: ProviderErrorCode;
  public readonly originalError?: Error;

  constructor(
    message: string,
    provider: string,
    code: ProviderErrorCode,
    originalError?: Error,
  ) {
    super(message, { cause: originalError });
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.originalError = originalError;
  }
}
