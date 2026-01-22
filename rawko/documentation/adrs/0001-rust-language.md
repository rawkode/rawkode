# ADR-0001: Rust Language

## Status

Accepted

## Context

rawko is an agentic coding robot that orchestrates LLM-based agents, manages subprocess communication, handles concurrent I/O, and provides a responsive CLI experience. The implementation language significantly impacts:

- Performance and resource usage
- Safety and reliability
- Developer productivity
- Ecosystem and library availability
- Distribution and deployment

Key requirements:
- Low latency for interactive CLI usage
- Safe concurrent I/O for agent communication
- Subprocess management for ACP transport
- Cross-platform support (macOS, Linux, Windows)
- Single binary distribution

## Decision

We will implement rawko in Rust.

## Consequences

### Positive

**Performance**
- Native compilation provides low latency startup
- Zero-cost abstractions for efficient resource usage
- No garbage collection pauses during execution
- Efficient memory usage important for long-running tasks

**Safety**
- Memory safety without runtime overhead
- Thread safety enforced at compile time
- Ownership model prevents data races
- No null pointer exceptions

**Concurrency**
- Async/await with Tokio for efficient I/O
- Safe concurrent access to shared state
- Fearless concurrency with ownership rules
- Efficient handling of multiple agent subprocesses

**Ecosystem**
- Strong CLI tooling (clap, indicatif, crossterm)
- Excellent HTTP clients (reqwest) for LLM APIs
- Quality JSON/YAML parsing (serde)
- OpenTelemetry support (tracing, opentelemetry-rust)
- FSM libraries available (statig)

**Distribution**
- Single static binary
- No runtime dependencies
- Easy cross-compilation
- Small binary size with optimization

### Negative

**Learning Curve**
- Rust has steeper learning curve than Python/Go
- Ownership concepts require adjustment
- Longer initial development time
- Smaller hiring pool

**Compilation Time**
- Slower compile times than Go
- Debug builds can be slow
- Incremental compilation helps but not eliminates

**Ecosystem Gaps**
- Some LLM SDKs are Python-first
- May need to build some integrations from scratch
- Async ecosystem still maturing

**Prototyping Speed**
- Less suitable for rapid prototyping
- Type system can slow experimentation
- More boilerplate for simple tasks

## Alternatives Considered

### Go

Pros:
- Fast compilation
- Simple concurrency model
- Good CLI ecosystem
- Easy to learn

Cons:
- Garbage collection can cause latency
- Less expressive type system
- No sum types (enums) for FSM states
- Less safe concurrent code

Rejected because: The FSM design benefits from Rust's enum types, and the safety guarantees are valuable for a tool that manages subprocesses and handles user code.

### Python

Pros:
- Best LLM SDK support
- Fastest prototyping
- Large community
- Easy to modify and extend

Cons:
- Slow startup time
- Poor concurrency story
- Complex distribution (virtualenv, dependencies)
- Type safety is opt-in and incomplete

Rejected because: Distribution complexity and performance requirements make Python unsuitable for a CLI tool.

### TypeScript/Node.js

Pros:
- Good async support
- Rich npm ecosystem
- Familiar to web developers
- Fast prototyping

Cons:
- Requires Node.js runtime
- Memory overhead
- Type safety limitations
- Startup time

Rejected because: Runtime requirement complicates distribution, and memory overhead is significant for long-running tasks.

### C++

Pros:
- Maximum performance
- Full control
- Large ecosystem

Cons:
- Memory safety issues
- Complex tooling
- Long development time
- Build system complexity

Rejected because: Development velocity too slow without safety benefits that Rust provides.
