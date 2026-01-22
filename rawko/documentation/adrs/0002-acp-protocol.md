# ADR-0002: ACP Protocol

## Status

Accepted

## Context

rawko orchestrates multiple agents that interact with LLMs and tools. We need a communication protocol between the rawko core and individual agents. This protocol must:

- Support multiple LLM providers (Anthropic, OpenAI, local models)
- Enable tool use (function calling)
- Handle streaming responses
- Allow agent implementation flexibility
- Support future extensibility

Options considered:
- Custom protocol
- Model Context Protocol (MCP)
- Agent Communication Protocol (ACP)
- Direct LLM API integration

## Decision

We will use the Agent Communication Protocol (ACP) for communication between rawko and agents.

## Consequences

### Positive

**Model Agnostic**
- Agents can use any LLM provider
- Provider choice can be per-agent
- Easy to swap models without protocol changes
- Supports local/self-hosted models

**Standardized Interface**
- Consistent message format across agents
- Tool definitions follow standard schema
- Clear request/response patterns
- Well-defined error handling

**Tool Support**
- First-class tool/function calling
- Standardized tool result format
- Multi-turn tool conversations
- Tool execution feedback

**Ecosystem Compatibility**
- Aligns with emerging agent standards
- Potential for third-party agent compatibility
- Future interoperability with other systems

**Implementation Flexibility**
- Agents can be any language
- Protocol is transport-agnostic
- Supports various execution models
- Clear separation of concerns

### Negative

**Protocol Overhead**
- Additional serialization/deserialization
- Extra layer between rawko and LLM
- Slightly higher latency than direct calls

**Limited Adoption**
- ACP is relatively new
- Fewer reference implementations
- Less community tooling
- May need to contribute to spec

**Translation Required**
- Must translate ACP to provider-specific formats
- Each LLM has different tool calling conventions
- Streaming behavior varies by provider

## Alternatives Considered

### Custom Protocol

Design our own agent communication format.

Pros:
- Tailored to exact needs
- No external dependencies
- Full control over evolution

Cons:
- Maintenance burden
- No ecosystem benefits
- Must define everything ourselves
- No compatibility with other tools

Rejected because: Reinventing the wheel when standards exist, and lose potential ecosystem benefits.

### Model Context Protocol (MCP)

Anthropic's protocol for tool integration.

Pros:
- Well-documented
- Growing adoption
- Good tooling support
- Anthropic backing

Cons:
- Focused on tool servers, not agents
- Doesn't define agent behavior patterns
- Model-specific origins
- Less suitable for agent orchestration

Not chosen as primary because: MCP is better suited for tool provision than agent communication. However, we will support MCP for tool servers.

### Direct LLM API Integration

Call LLM APIs directly without abstraction.

Pros:
- Simplest implementation
- No translation overhead
- Direct access to all features

Cons:
- Provider lock-in per agent
- Must handle each API differently
- Harder to swap models
- Code duplication

Rejected because: Loses flexibility and creates tight coupling to specific providers.

### LangChain/LlamaIndex Abstractions

Use existing Python frameworks.

Pros:
- Mature abstractions
- Lots of integrations
- Active community

Cons:
- Python dependency
- Heavy abstraction layer
- Different design philosophy
- Would require FFI or subprocess

Rejected because: Incompatible with Rust implementation and adds significant complexity.

## Notes

- ACP messages are transported over stdio to agent subprocesses (see ADR-0007)
- Tool definitions in agent specs translate to ACP tool schemas
- rawko handles ACP↔provider translation for built-in agents
