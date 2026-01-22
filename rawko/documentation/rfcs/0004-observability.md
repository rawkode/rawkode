# RFC-0004: Observability

## Abstract

This RFC specifies the observability strategy for rawko, built on OpenTelemetry (OTEL) for distributed tracing. The system produces structured traces for all operations, with a terminal subscriber for real-time human-readable output and support for external collectors for advanced analysis.

## Motivation

Observability in rawko serves multiple audiences:

1. **Users**: Understanding what's happening during execution
2. **Developers**: Debugging issues and performance problems
3. **Operations**: Monitoring production deployments
4. **Analysis**: Understanding usage patterns and agent effectiveness

Requirements:
- Real-time visibility into agent execution
- Structured data for analysis
- Low overhead for normal operation
- Extensible to external systems

OpenTelemetry provides:
- Industry-standard tracing format
- Rich ecosystem of exporters
- Rust SDK with good async support
- Future-proof architecture

## Detailed Design

### Trace Structure

rawko produces hierarchical traces:

```
Task (root span)
├── Arbiter Decision
│   └── LLM Call
├── Agent Execution (planner)
│   ├── LLM Call
│   └── Tool Execution (filesystem.read)
├── Arbiter Decision
│   └── LLM Call
├── Agent Execution (developer)
│   ├── LLM Call
│   ├── Tool Execution (filesystem.read)
│   ├── Tool Execution (filesystem.write)
│   ├── Tool Execution (shell.exec)
│   └── LLM Call
└── Arbiter Decision (complete)
    └── LLM Call
```

### Span Types

#### Task Span

Root span for entire task execution:

```
Name: task
Attributes:
  task.id: "abc123"
  task.request: "Fix the login bug"
  task.status: "completed" | "failed"
  task.duration_ms: 45200
  task.turns: 7
  task.agents_used: ["planner", "developer", "reviewer"]
```

#### Arbiter Span

Arbiter decision points:

```
Name: arbiter
Attributes:
  arbiter.decision: "select_agent" | "complete" | "retry"
  arbiter.selected_agent: "developer"
  arbiter.reason: "Plan is ready for implementation"
  arbiter.turn: 3
```

#### Agent Span

Individual agent execution:

```
Name: agent
Attributes:
  agent.name: "developer"
  agent.status: "complete" | "failed"
  agent.duration_ms: 23100
  agent.tool_calls: 12
  agent.model: "claude-3-opus"
  agent.tokens_in: 15000
  agent.tokens_out: 2500
```

#### LLM Call Span

Individual LLM API calls:

```
Name: llm
Attributes:
  llm.provider: "anthropic"
  llm.model: "claude-3-opus-20240229"
  llm.tokens_in: 5000
  llm.tokens_out: 800
  llm.duration_ms: 3200
  llm.streaming: true
```

#### Tool Execution Span

Tool invocations:

```
Name: tool
Attributes:
  tool.category: "filesystem"
  tool.name: "read"
  tool.target: "src/auth/sso.rs"
  tool.status: "success" | "error"
  tool.duration_ms: 15
  tool.bytes: 2048
```

### Events

Spans include events for notable occurrences:

```rust
span.add_event("agent_output", vec![
    KeyValue::new("content_preview", "I've fixed the SSO..."),
    KeyValue::new("content_length", 1500),
]);

span.add_event("tool_error", vec![
    KeyValue::new("error", "File not found: /nonexistent"),
    KeyValue::new("tool", "filesystem.read"),
]);
```

### Terminal Subscriber

Real-time output for CLI users:

```
[10:30:00] Task started: Fix the login bug
[10:30:01] → Arbiter: Selecting planner (task needs analysis)
[10:30:02] → Planner: Reading auth/sso.rs
[10:30:03] → Planner: Searching codebase for "SSO"
[10:30:08] ← Planner: Complete (5 tool calls, 8.3s)
           Plan created with 3 steps
[10:30:08] → Arbiter: Selecting developer (plan ready)
[10:30:09] → Developer: Reading auth/sso.rs
[10:30:12] → Developer: Writing auth/sso.rs
[10:30:15] → Developer: Running cargo check
[10:30:30] → Developer: Running cargo test auth
[10:30:35] ← Developer: Complete (12 tool calls, 23.1s)
           Fixed token validation, updated tests
[10:30:35] → Arbiter: Selecting reviewer
[10:30:36] → Reviewer: Checking git diff
[10:30:45] ← Reviewer: Complete (4 tool calls, 10.2s)
           Review passed
[10:30:45] → Arbiter: Task complete
[10:30:45] Task completed in 45.2s
           Modified: auth/sso.rs, tests/auth_test.rs
```

#### Verbosity Levels

```bash
rawko task "Fix bug"              # Default: progress indicators
rawko task "Fix bug" -v           # Verbose: tool details
rawko task "Fix bug" -vv          # Debug: full content
rawko task "Fix bug" -q           # Quiet: errors only
```

| Level | Shows |
|-------|-------|
| quiet | Errors and final result only |
| default | Progress, agent transitions, summaries |
| verbose | Tool calls with targets, timing |
| debug | Full content, LLM tokens, all attributes |

### Configuration

```cue
observability: {
    // Terminal output
    terminal: {
        enabled: true
        verbosity: "default"    // quiet, default, verbose, debug
        color: "auto"           // auto, always, never
        timestamps: true
        progress_indicators: true
    }

    // OTEL export
    otel: {
        enabled: false
        endpoint: "http://localhost:4317"
        protocol: "grpc"        // grpc, http
        headers: {}

        sampling: {
            rate: 1.0           // Sample all traces
            // Or: parent_based, trace_id_ratio
        }
    }

    // File export
    file: {
        enabled: false
        path: ".rawko/traces/"
        format: "json"          // json, otlp
        rotation: {
            max_size: "100MB"
            max_files: 10
        }
    }
}
```

### Integration with External Collectors

Supported backends via OTEL exporters:

| Backend | Protocol | Use Case |
|---------|----------|----------|
| Jaeger | OTLP/gRPC | Local development, debugging |
| Grafana Tempo | OTLP/gRPC | Production monitoring |
| Honeycomb | OTLP/HTTP | SaaS observability |
| Datadog | OTLP/HTTP | Enterprise monitoring |

Example Jaeger setup:

```bash
# Start Jaeger
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  jaegertracing/all-in-one

# Configure rawko
rawko config set observability.otel.enabled true
rawko config set observability.otel.endpoint "http://localhost:4317"

# Run task
rawko task "Fix bug"

# View traces at http://localhost:16686
```

### Metrics (Future)

Planned metrics for production monitoring:

```
rawko_tasks_total{status="completed|failed"}
rawko_task_duration_seconds{agent="developer"}
rawko_agent_invocations_total{agent="developer",status="success|failure"}
rawko_tool_calls_total{category="filesystem",tool="read"}
rawko_llm_tokens_total{provider="anthropic",direction="in|out"}
rawko_llm_duration_seconds{provider="anthropic",model="claude-3-opus"}
```

### Implementation

Using `tracing` crate with OTEL integration:

```rust
use tracing::{info_span, instrument, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

#[instrument(skip(self), fields(task.id = %task_id))]
async fn execute_task(&self, task_id: &str, request: &str) -> Result<TaskResult> {
    let span = tracing::Span::current();
    span.set_attribute("task.request", request.to_string());

    loop {
        let agent = self.arbiter_select_agent().await?;

        let result = async {
            self.execute_agent(agent).await
        }
        .instrument(info_span!("agent", agent.name = %agent.name))
        .await?;

        if self.arbiter_is_complete(&result).await? {
            break;
        }
    }

    Ok(result)
}
```

Terminal subscriber implementation:

```rust
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub fn init_tracing(config: &ObservabilityConfig) {
    let terminal_layer = TerminalLayer::new(config.terminal.clone());

    let mut layers = vec![terminal_layer.boxed()];

    if config.otel.enabled {
        let otel_layer = tracing_opentelemetry::layer()
            .with_exporter(build_exporter(&config.otel));
        layers.push(otel_layer.boxed());
    }

    tracing_subscriber::registry()
        .with(layers)
        .init();
}
```

## Drawbacks

1. **Overhead**: Tracing adds some performance cost
2. **Complexity**: OTEL setup can be complex
3. **Data volume**: Verbose traces consume storage
4. **Learning curve**: OTEL concepts unfamiliar to some

## Alternatives

### Custom Logging

Simple log statements. Rejected because:
- No structured correlation
- Hard to analyze programmatically
- No standard format

### Proprietary APM

Vendor-specific tracing. Rejected because:
- Lock-in to single vendor
- May require paid service
- Less ecosystem support

### No Tracing

Rely only on state persistence. Rejected because:
- No real-time visibility
- Missing timing information
- Harder to debug performance

## Unresolved Questions

1. **Sensitive data**: How to redact secrets in traces?
2. **Trace sampling**: Smart sampling for high-volume usage?
3. **Custom exporters**: Desktop app visualization?
4. **Correlation**: Link traces to git commits/PRs?
5. **Cost tracking**: Include LLM costs in spans?
