# ADR-0009: OTEL Observability

## Status

Accepted

## Context

rawko needs observability for:

- User visibility into execution progress
- Debugging agent behavior
- Performance analysis
- Production monitoring (future)
- Usage analytics (optional)

Observability approaches considered:
- OpenTelemetry (OTEL)
- Custom logging
- Structured logging only
- APM vendor SDK
- No observability

## Decision

We will use OpenTelemetry for observability, with the `tracing` crate as the Rust API and OTEL exporters for external systems.

## Consequences

### Positive

**Future-Proof**
- Industry standard for observability
- Growing ecosystem
- Vendor-neutral
- Active development

**Distributed Tracing**
- Correlated spans across operations
- Parent-child relationships
- Timing information
- Context propagation

**Rich Data Model**
- Traces, spans, events
- Attributes on everything
- Structured metadata
- Queryable data

**Flexible Export**
- Terminal output for CLI
- OTLP for external collectors
- File export for offline analysis
- Multiple exporters simultaneously

**Rust Integration**
- tracing crate is idiomatic
- Procedural macros for ease
- Zero-cost when disabled
- Async-compatible

**Ecosystem**
- Jaeger, Grafana, Honeycomb support
- Growing tooling
- Community resources
- Standard protocols

### Negative

**Complexity**
- OTEL has many concepts
- Configuration can be overwhelming
- Learning curve
- Over-engineered for simple cases

**Overhead**
- Some runtime cost
- Memory for span storage
- CPU for serialization
- Network for export

**Setup Required**
- External collectors needed for full value
- Docker/services to run
- Configuration for production
- User education needed

**Evolving Standard**
- OTEL still stabilizing
- Breaking changes possible
- Rust SDK less mature than others
- Some features experimental

## Alternatives Considered

### Custom Logging

Simple log statements with levels.

Pros:
- Simple to implement
- Low overhead
- Familiar pattern
- No dependencies

Cons:
- No correlation
- Hard to analyze
- No timing
- No structure

Rejected because: Insufficient for understanding agent orchestration.

### Structured Logging Only

JSON logs without tracing.

Pros:
- Simpler than tracing
- Parseable logs
- Lower complexity
- Searchable

Cons:
- No span correlation
- Manual timing
- No parent-child
- Limited analysis

Not sufficient because: Need trace correlation for multi-agent flows.

### Vendor APM SDK

DataDog, New Relic, etc.

Pros:
- Full-featured
- Good UIs
- Managed infrastructure
- Support available

Cons:
- Vendor lock-in
- Cost for users
- SDK dependencies
- Not open source

Rejected because: Lock-in inappropriate for open source tool.

### No Observability

Rely on state persistence for debugging.

Pros:
- Simplest
- No overhead
- No dependencies
- No complexity

Cons:
- Blind during execution
- Hard to debug
- Poor user experience
- No real-time visibility

Rejected because: Users need to see what's happening.

## Implementation

### Tracing Setup

```rust
use tracing::{info_span, instrument, Instrument};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tracing_opentelemetry::OpenTelemetryLayer;

pub fn init_observability(config: &Config) -> Result<()> {
    let mut layers = Vec::new();

    // Terminal layer (always enabled for CLI)
    if config.observability.terminal.enabled {
        let terminal = TerminalLayer::new(&config.observability.terminal);
        layers.push(terminal.boxed());
    }

    // OTEL layer (optional)
    if config.observability.otel.enabled {
        let tracer = opentelemetry_otlp::new_pipeline()
            .tracing()
            .with_exporter(
                opentelemetry_otlp::new_exporter()
                    .tonic()
                    .with_endpoint(&config.observability.otel.endpoint),
            )
            .install_batch(opentelemetry_sdk::runtime::Tokio)?;

        let otel = OpenTelemetryLayer::new(tracer);
        layers.push(otel.boxed());
    }

    tracing_subscriber::registry()
        .with(layers)
        .init();

    Ok(())
}
```

### Instrumentation

```rust
#[instrument(skip(self), fields(task.id = %task_id))]
pub async fn execute_task(&self, task_id: &str, request: &str) -> Result<TaskResult> {
    info!("Task started");

    let decision = self.arbiter_select(request)
        .instrument(info_span!("arbiter"))
        .await?;

    let result = self.run_agent(&decision.agent)
        .instrument(info_span!("agent", name = %decision.agent))
        .await?;

    info!("Task completed");
    Ok(result)
}
```

### Terminal Layer

Custom subscriber for CLI output:

```rust
pub struct TerminalLayer {
    verbosity: Verbosity,
    writer: Mutex<Box<dyn Write + Send>>,
}

impl<S> Layer<S> for TerminalLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        // Format and print span start
        let span = ctx.span(id).unwrap();
        let name = span.name();

        match self.verbosity {
            Verbosity::Default => {
                if name == "agent" || name == "arbiter" {
                    writeln!(self.writer.lock().unwrap(), "→ {}", name);
                }
            }
            Verbosity::Verbose => {
                // More detail
            }
            _ => {}
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        // Format and print events
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        // Print span completion
    }
}
```

### Span Hierarchy

```
task
├── arbiter (decision: select planner)
├── agent (name: planner)
│   ├── llm_call
│   └── tool (filesystem.read)
├── arbiter (decision: select developer)
├── agent (name: developer)
│   ├── llm_call
│   ├── tool (filesystem.write)
│   └── tool (shell.exec)
└── arbiter (decision: complete)
```

### Attributes Standard

| Span | Attributes |
|------|------------|
| task | task.id, task.request, task.status |
| arbiter | arbiter.decision, arbiter.agent, arbiter.reason |
| agent | agent.name, agent.status, agent.duration_ms |
| llm_call | llm.provider, llm.model, llm.tokens_in/out |
| tool | tool.category, tool.name, tool.status |

## Notes

- Terminal output is the primary interface during execution
- OTEL export is opt-in for advanced users
- Consider cost of trace storage for long tasks
- Span sampling may be needed for high-volume usage
