# ADR-0004: Tokio Runtime

## Status

Accepted

## Context

rawko requires an async runtime for:

- Non-blocking I/O with LLM APIs
- Subprocess management (agent communication)
- Concurrent tool execution
- Streaming response handling
- Timeout management

Rust async runtimes considered:
- Tokio
- async-std
- smol
- Custom runtime

## Decision

We will use Tokio as the async runtime.

## Consequences

### Positive

**Battle-Tested**
- Most widely used Rust async runtime
- Production-proven at scale
- Well-understood behavior
- Extensive testing

**Ecosystem Support**
- Most async crates assume Tokio
- reqwest (HTTP) uses Tokio
- tonic (gRPC) built on Tokio
- tracing ecosystem integrates well
- Best async subprocess support

**Feature Rich**
- Full-featured I/O primitives
- Timers and timeouts
- Synchronization primitives
- Process spawning
- Signal handling

**Performance**
- Work-stealing scheduler
- Efficient task waking
- Low overhead
- Good for I/O-bound workloads

**Tooling**
- tokio-console for debugging
- Good error messages
- Extensive documentation
- Active maintenance

### Negative

**Binary Size**
- Larger than minimal runtimes
- Many features may be unused
- Feature flags help but add complexity

**Complexity**
- Large API surface
- Many configuration options
- Can be overwhelming

**Lock-in**
- Some crates are Tokio-specific
- Switching runtimes is difficult
- Ecosystem fragmentation

**Compile Time**
- Adds to compile times
- Many dependencies
- Proc macros used internally

## Alternatives Considered

### async-std

Pros:
- Simpler API
- Closer to std library
- Smaller dependency tree

Cons:
- Smaller ecosystem
- Less production usage
- Fewer integrations

Rejected because: Key dependencies (reqwest, tonic) don't support async-std well.

### smol

Pros:
- Minimal and lightweight
- Fast compilation
- Simple design

Cons:
- Limited features
- Small ecosystem
- Less tooling

Rejected because: Missing features needed for subprocess management and complex I/O.

### Custom Runtime

Build minimal runtime for our needs.

Pros:
- Exact features needed
- No extra dependencies
- Full control

Cons:
- Significant effort
- Must handle edge cases
- No ecosystem benefits
- Ongoing maintenance

Rejected because: Async runtimes are complex; using proven solution is safer.

### No Async (Threads)

Use OS threads instead of async.

Pros:
- Simpler mental model
- No async/await complexity
- Easier debugging

Cons:
- Higher memory per connection
- Thread creation overhead
- Less efficient I/O
- Harder to compose operations

Rejected because: Multiple concurrent agent operations benefit from async's efficiency.

## Configuration

```rust
#[tokio::main]
async fn main() -> Result<()> {
    // Default multi-threaded runtime
    rawko::run().await
}

// Or with custom configuration
fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()?;

    runtime.block_on(rawko::run())
}
```

## Feature Flags

We use specific Tokio features to minimize bloat:

```toml
[dependencies.tokio]
version = "1"
features = [
    "rt-multi-thread",  # Multi-threaded runtime
    "io-util",          # I/O utilities
    "process",          # Subprocess support
    "time",             # Timers and timeouts
    "sync",             # Synchronization primitives
    "macros",           # #[tokio::main] and friends
    "signal",           # Signal handling
]
```

## Notes

- All async code should be runtime-agnostic where possible
- Use `tokio::spawn` for concurrent operations
- Subprocess communication uses `tokio::process`
- Timeouts handled via `tokio::time::timeout`
