# SPEC-0002: Provider Interface

## Abstract

This specification defines the provider abstraction layer for rawko-sdk, enabling unified interaction with Claude Agent SDK and GitHub Copilot SDK through common interfaces.

## Motivation

rawko-sdk must support multiple LLM providers while maintaining a clean separation between orchestration logic and provider-specific implementations. A well-defined interface contract allows:

- Provider implementations to be developed and tested independently
- Core orchestration to remain provider-agnostic
- Future providers to be added without modifying core code
- Consistent behavior across different LLM backends

## Detailed Design

### Core Types

#### Provider Interface

```typescript
/**
 * Provider represents an LLM service that can create conversation sessions.
 */
interface Provider {
  /** Unique identifier for this provider (e.g., "claude", "copilot") */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Create a new session with this provider.
   * @param config - Session configuration including model and parameters
   * @returns A new ProviderSession instance
   */
  createSession(config: SessionConfig): Promise<ProviderSession>;

  /**
   * Validate that the provider is properly configured.
   * @returns true if API keys and configuration are valid
   */
  validate(): Promise<boolean>;
}
```

#### SessionConfig

```typescript
/**
 * Configuration for creating a new provider session.
 */
interface SessionConfig {
  /** Model identifier (e.g., "claude-sonnet-4", "gpt-4") */
  model: string;

  /** Maximum tokens for responses */
  maxTokens?: number;

  /** Temperature for response randomness (0-1) */
  temperature?: number;

  /** System prompt to initialize the session */
  systemPrompt?: string;

  /** Initial tools available to the session */
  tools?: ToolDefinition[];

  /** Optional session ID for resumption */
  sessionId?: string;
}
```

#### ProviderSession Interface

```typescript
/**
 * ProviderSession represents an active conversation with an LLM provider.
 */
interface ProviderSession {
  /** Unique session identifier */
  readonly id: string;

  /** Provider name this session belongs to */
  readonly provider: string;

  /** Current model being used */
  readonly model: string;

  /**
   * Send a message and receive a stream of events.
   * @param message - The message to send
   * @returns AsyncIterable of StreamEvent
   */
  sendMessage(message: Message): AsyncIterable<StreamEvent>;

  /**
   * Update the available tools for this session.
   * @param tools - New tool definitions
   */
  setTools(tools: ToolDefinition[]): void;

  /**
   * Update the system prompt for this session.
   * @param prompt - New system prompt
   */
  setSystemPrompt(prompt: string): void;

  /**
   * Get the conversation history.
   * @returns Array of messages in conversation order
   */
  getHistory(): Message[];

  /**
   * Clear the conversation history while preserving session.
   */
  clearHistory(): void;

  /**
   * Get current token usage statistics.
   */
  getUsage(): TokenUsage;

  /**
   * Close the session and release resources.
   */
  close(): Promise<void>;
}
```

### Message Types

```typescript
/**
 * A message in the conversation.
 */
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

interface UserMessage {
  role: "user";
  content: string;
}

interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
```

### Stream Events

```typescript
/**
 * Events emitted during message streaming.
 */
type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseInputEvent
  | ToolUseEndEvent
  | ToolResultEvent
  | MessageDoneEvent
  | ErrorEvent;

interface TextDeltaEvent {
  type: "text_delta";
  /** Incremental text content */
  delta: string;
}

interface ToolUseStartEvent {
  type: "tool_use_start";
  /** Unique ID for this tool call */
  id: string;
  /** Tool name being invoked */
  name: string;
}

interface ToolUseInputEvent {
  type: "tool_use_input";
  /** Tool call ID */
  id: string;
  /** Incremental JSON input */
  delta: string;
}

interface ToolUseEndEvent {
  type: "tool_use_end";
  /** Tool call ID */
  id: string;
  /** Complete parsed input */
  input: unknown;
}

interface ToolResultEvent {
  type: "tool_result";
  /** Tool call ID this result is for */
  id: string;
  /** Tool execution output */
  output: string;
  /** Whether the tool execution failed */
  isError: boolean;
}

interface MessageDoneEvent {
  type: "message_done";
  /** Final complete message */
  message: AssistantMessage;
  /** Token usage for this message */
  usage: TokenUsage;
  /** Stop reason */
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

interface ErrorEvent {
  type: "error";
  /** Error that occurred */
  error: ProviderError;
}
```

### Tool Definitions

```typescript
/**
 * Provider-agnostic tool definition.
 */
interface ToolDefinition {
  /** Unique tool name */
  name: string;

  /** Human-readable description for the LLM */
  description: string;

  /** JSON Schema for tool parameters */
  parameters: JSONSchema;

  /**
   * Optional handler function.
   * If not provided, tool execution is delegated to the orchestrator.
   */
  handler?: (input: unknown) => Promise<ToolResult>;
}

interface ToolResult {
  output: string;
  isError?: boolean;
}

/**
 * Subset of JSON Schema used for tool parameters.
 */
interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface JSONSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  default?: unknown;
}
```

### Token Usage

```typescript
/**
 * Token usage statistics.
 */
interface TokenUsage {
  /** Tokens used for input/prompt */
  inputTokens: number;

  /** Tokens used for output/completion */
  outputTokens: number;

  /** Total tokens used */
  totalTokens: number;

  /** Cache read tokens (if applicable) */
  cacheReadTokens?: number;

  /** Cache write tokens (if applicable) */
  cacheWriteTokens?: number;
}
```

### Error Types

```typescript
/**
 * Provider-specific errors.
 */
class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type ProviderErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "context_length_exceeded"
  | "invalid_request"
  | "model_unavailable"
  | "network_error"
  | "unknown";
```

### Provider Factory

```typescript
/**
 * Factory for creating provider instances.
 */
class ProviderFactory {
  private static providers = new Map<string, Provider>();

  /**
   * Register a provider implementation.
   */
  static register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider by name.
   */
  static get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider not found: ${name}. Available: ${[...this.providers.keys()].join(", ")}`);
    }
    return provider;
  }

  /**
   * List all registered provider names.
   */
  static list(): string[] {
    return [...this.providers.keys()];
  }
}
```

## Claude Provider Implementation

```typescript
import { Claude } from "npm:@anthropic-ai/claude-agent-sdk";

class ClaudeProvider implements Provider {
  readonly name = "claude";
  readonly displayName = "Anthropic Claude";

  private client: Claude;

  constructor(apiKey?: string) {
    this.client = new Claude({
      apiKey: apiKey ?? Deno.env.get("ANTHROPIC_API_KEY"),
    });
  }

  async createSession(config: SessionConfig): Promise<ProviderSession> {
    return new ClaudeSession(this.client, config);
  }

  async validate(): Promise<boolean> {
    try {
      // Attempt a minimal API call to validate credentials
      return true;
    } catch {
      return false;
    }
  }
}

class ClaudeSession implements ProviderSession {
  readonly id: string;
  readonly provider = "claude";
  readonly model: string;

  private history: Message[] = [];
  private tools: ToolDefinition[] = [];
  private systemPrompt: string;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  constructor(
    private client: Claude,
    config: SessionConfig
  ) {
    this.id = config.sessionId ?? crypto.randomUUID();
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? "";
    this.tools = config.tools ?? [];
  }

  async *sendMessage(message: Message): AsyncIterable<StreamEvent> {
    this.history.push(message);

    const stream = await this.client.messages.stream({
      model: this.model,
      system: this.systemPrompt,
      messages: this.translateHistory(),
      tools: this.tools.map(toClaudeTool),
      max_tokens: 8192,
    });

    for await (const event of stream) {
      yield this.translateEvent(event);
    }
  }

  private translateEvent(event: ClaudeStreamEvent): StreamEvent {
    // Translation logic from Claude events to unified StreamEvent
    switch (event.type) {
      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          return { type: "text_delta", delta: event.delta.text };
        }
        // Handle tool_use deltas...
        break;
      case "message_stop":
        return {
          type: "message_done",
          message: this.buildAssistantMessage(event),
          usage: this.usage,
          stopReason: event.message.stop_reason,
        };
    }
    // ... additional cases
  }

  // ... remaining methods
}
```

## Copilot Provider Implementation

```typescript
import { Copilot } from "npm:@github/copilot-sdk";

class CopilotProvider implements Provider {
  readonly name = "copilot";
  readonly displayName = "GitHub Copilot";

  private client: Copilot;

  constructor(token?: string) {
    this.client = new Copilot({
      token: token ?? Deno.env.get("GITHUB_TOKEN"),
    });
  }

  async createSession(config: SessionConfig): Promise<ProviderSession> {
    return new CopilotSession(this.client, config);
  }

  async validate(): Promise<boolean> {
    try {
      // Validate GitHub token has Copilot access
      return true;
    } catch {
      return false;
    }
  }
}

class CopilotSession implements ProviderSession {
  // Similar implementation with Copilot-specific event translation
}
```

## Examples

### Basic Usage

```typescript
// Get provider from factory
const provider = ProviderFactory.get("claude");

// Create session
const session = await provider.createSession({
  model: "claude-sonnet-4",
  systemPrompt: "You are a helpful coding assistant.",
  tools: [readTool, writeTool],
});

// Send message and process stream
for await (const event of session.sendMessage({ role: "user", content: "Hello!" })) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_use_end":
      const result = await executeTool(event.name, event.input);
      // Feed result back...
      break;
    case "message_done":
      console.log("\n[Done]", event.usage);
      break;
  }
}

// Clean up
await session.close();
```

### Switching Providers

```typescript
// Configuration-driven provider selection
const config = await loadConfig(".rawko/config.yaml");
const provider = ProviderFactory.get(config.provider.default);

// Same code works with any provider
const session = await provider.createSession({
  model: config.provider[config.provider.default].model,
  // ...
});
```

## Drawbacks

1. **Lowest common denominator** - The unified interface may not expose all features of each provider
2. **Event translation overhead** - Converting between event formats adds processing
3. **Maintenance burden** - SDK updates may require interface changes
4. **Type safety limits** - Generic `unknown` types for tool inputs reduce compile-time safety

## Unresolved Questions

1. **Streaming backpressure** - How to handle slow consumers of the event stream?
2. **Session serialization** - What format for persisting sessions to disk?
3. **Provider-specific extensions** - How to expose advanced features without breaking abstraction?
4. **Retry semantics** - Should retry logic be in the provider or orchestrator layer?
