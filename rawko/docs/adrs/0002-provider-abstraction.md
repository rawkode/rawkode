# ADR-0002: Provider Abstraction Layer

## Status

Accepted (2026-01-23)

## Context

rawko-sdk needs to support multiple LLM providers:

1. **Claude Agent SDK** - Anthropic's official SDK for building AI agents
2. **GitHub Copilot SDK** - GitHub's SDK for Copilot-powered tools

Each SDK has its own:
- Authentication mechanisms
- API surface and method signatures
- Event/streaming models
- Tool definition formats
- Session management approaches

Without abstraction, the core orchestration logic would be tightly coupled to specific provider implementations, making it difficult to:
- Add new providers in the future
- Test components in isolation
- Switch providers based on configuration

## Decision

Abstract Claude Agent SDK and GitHub Copilot SDK behind a unified **Provider** interface.

### Core Interfaces

```typescript
interface Provider {
  readonly name: string;
  createSession(config: SessionConfig): Promise<ProviderSession>;
}

interface ProviderSession {
  readonly id: string;
  readonly provider: string;

  sendMessage(message: Message): AsyncIterable<StreamEvent>;
  setTools(tools: ToolDefinition[]): void;
  getHistory(): Message[];
  close(): Promise<void>;
}
```

### Design Principles

1. **Factory pattern** - `Provider.createSession()` instantiates provider-specific sessions
2. **Unified event model** - Translate Claude hooks and Copilot events to common `StreamEvent` types
3. **Tool normalization** - Convert rawko tool definitions to provider-specific formats internally
4. **Configuration-driven** - Provider selection via `.rawko/config.yaml`

## Consequences

### Positive

- **Provider agnostic core** - XState machine and arbiter work with any provider
- **Easy provider switching** - Change `provider.default` in config without code changes
- **Testability** - Mock providers for unit testing
- **Future extensibility** - Add Ollama, OpenAI, or other providers without core changes
- **Consistent API** - Single interface for all LLM interactions

### Negative

- **Abstraction overhead** - Additional layer between rawko and SDKs
- **Feature limitations** - Unified interface may not expose all provider-specific features
- **Translation complexity** - Event and tool format translation requires maintenance
- **Debugging difficulty** - Provider-specific issues may be obscured by abstraction

## Alternatives Considered

### Direct SDK Usage

**Approach**: Use Claude/Copilot SDKs directly throughout codebase with conditional logic

**Pros**: Full access to SDK features, no translation layer
**Cons**: Provider-specific code scattered throughout, difficult to add providers, poor testability

**Rejected because**: Tight coupling would make the codebase brittle and hard to extend.

### Plugin Architecture

**Approach**: Providers as dynamically loaded plugins with runtime discovery

**Pros**: Maximum extensibility, clean separation
**Cons**: Complexity overhead, runtime loading issues in Deno, overkill for 2-3 providers

**Rejected because**: Plugin system is overengineered for the initial provider set; can migrate to plugins later if needed.

### Adapter Pattern Only

**Approach**: Thin adapters without unified session abstraction

**Pros**: Simpler than full abstraction
**Cons**: Doesn't handle session lifecycle, event streams still diverge

**Rejected because**: Session management is critical for conversation continuity across agent transitions.

## Implementation Notes

### Provider Registration

```typescript
// src/providers/registry.ts
const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

// Initialize built-in providers
registerProvider(new ClaudeProvider());
registerProvider(new CopilotProvider());
```

### Event Translation

Both SDKs emit streaming events that must be normalized:

```typescript
// Unified event types
type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown }
  | { type: "error"; error: Error }
  | { type: "done"; usage?: TokenUsage };

// Claude SDK hooks → StreamEvent
function translateClaudeEvent(hook: ClaudeHook): StreamEvent {
  switch (hook.type) {
    case "text_delta":
      return { type: "text", content: hook.delta };
    case "tool_use":
      return { type: "tool_use", id: hook.id, name: hook.name, input: hook.input };
    // ...
  }
}

// Copilot SDK events → StreamEvent
function translateCopilotEvent(event: CopilotEvent): StreamEvent {
  // Similar translation logic
}
```

### Tool Definition Normalization

```typescript
// rawko's tool definition (provider-agnostic)
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// Convert to Claude format
function toClaudeTool(tool: ToolDefinition): ClaudeToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

// Convert to Copilot format
function toCopilotTool(tool: ToolDefinition): CopilotToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
```

### Configuration Example

```yaml
# .rawko/config.yaml
provider:
  default: copilot  # or "claude"

  claude:
    model: claude-sonnet-4
    maxTokens: 8192

  copilot:
    model: gpt-4
    maxTokens: 8192
```

See [SPEC-0002: Provider Interface](../specs/0002-provider-interface.md) for complete interface definitions.
