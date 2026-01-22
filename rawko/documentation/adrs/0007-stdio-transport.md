# ADR-0007: stdio Transport

## Status

Accepted

## Context

rawko needs to communicate with agent processes. The Agent Communication Protocol (ACP) is transport-agnostic, so we must choose how messages flow between rawko and agents. Requirements:

- Reliable message delivery
- Support for streaming
- Simple deployment (no server setup)
- Works across platforms
- Low latency

Transport options considered:
- stdio (stdin/stdout)
- HTTP/REST
- gRPC
- WebSocket
- Unix sockets
- TCP sockets

## Decision

We will use stdio (stdin/stdout) as the transport layer for ACP communication with agent subprocesses.

## Consequences

### Positive

**Simplicity**
- No port allocation needed
- No server management
- Works immediately
- No network configuration

**Process Model**
- Each agent is a subprocess
- Natural lifecycle management
- OS handles cleanup
- Clear parent-child relationship

**Security**
- No network exposure
- No open ports
- Subprocess inherits permissions
- Easy to sandbox

**Cross-Platform**
- Works on all OS
- No platform-specific code
- Standard I/O primitives
- Universal availability

**Streaming Support**
- Natural line-based streaming
- Efficient for incremental output
- No chunking complexity
- Backpressure via pipe buffering

**Debugging**
- Easy to inspect with standard tools
- Can manually interact with agents
- Log analysis straightforward
- Pipe to files for replay

### Negative

**Single Connection**
- One stdin, one stdout per process
- Can't multiplex connections
- One agent per subprocess
- No concurrent requests to same agent

**Text-Based**
- Must serialize to text
- JSON parsing overhead
- No binary efficiency
- Escaping required

**Process Overhead**
- New process per agent invocation
- Startup time for each agent
- Memory per process
- OS limits on processes

**No Remote Agents**
- Agents must be local
- Can't distribute to other machines
- No network scaling
- Single host limitation

**Error Handling**
- stderr mixed with errors
- Exit codes limited information
- Crash detection via process
- No reconnection

## Alternatives Considered

### HTTP/REST

Run agents as HTTP servers.

Pros:
- Well-understood protocol
- Good tooling
- Remote capable
- Concurrent requests

Cons:
- Port allocation complexity
- Server management
- Higher latency
- Heavier implementation

Rejected because: Unnecessary complexity for local subprocess model.

### gRPC

Use gRPC for typed communication.

Pros:
- Strong typing
- Efficient binary protocol
- Bidirectional streaming
- Good Rust support

Cons:
- Requires protobuf
- More setup
- Overkill for subprocess
- Adds dependencies

Rejected because: Extra complexity not justified for local communication.

### WebSocket

Persistent WebSocket connections.

Pros:
- Bidirectional
- Streaming friendly
- Well-supported
- Connection reuse

Cons:
- Requires HTTP server
- More complex setup
- Port management
- Browser-oriented design

Rejected because: Server-based model adds unnecessary complexity.

### Unix Sockets

Use Unix domain sockets.

Pros:
- Fast local IPC
- No port conflicts
- Filesystem-based addressing
- Good performance

Cons:
- Not cross-platform (Windows differs)
- Cleanup complexity
- Permission management
- More complex than stdio

Not chosen because: Platform differences and stdio is simpler.

### TCP Sockets

Direct TCP connections.

Pros:
- Flexible
- Remote capable
- Well-understood
- Bidirectional

Cons:
- Port allocation
- Connection management
- No process lifecycle tie
- More error handling

Rejected because: Port management adds friction for local use.

## Implementation

### Agent Subprocess

```rust
use tokio::process::{Command, Child};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct AgentProcess {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

impl AgentProcess {
    pub async fn spawn(agent: &AgentDef) -> Result<Self> {
        let mut child = Command::new(&agent.command)
            .args(&agent.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // Errors to parent stderr
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());

        Ok(Self { child, stdin, stdout })
    }

    pub async fn send(&mut self, message: &AcpMessage) -> Result<()> {
        let json = serde_json::to_string(message)?;
        self.stdin.write_all(json.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    pub async fn receive(&mut self) -> Result<AcpMessage> {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        let message = serde_json::from_str(&line)?;
        Ok(message)
    }
}
```

### Message Format

```json
{"type":"request","id":"req-123","method":"execute","params":{...}}
{"type":"response","id":"req-123","result":{...}}
{"type":"stream","id":"req-123","delta":"partial content..."}
```

### Streaming Pattern

```rust
pub async fn stream_response(&mut self) -> impl Stream<Item = Result<AcpChunk>> {
    stream! {
        loop {
            let msg = self.receive().await?;
            match msg {
                AcpMessage::Stream { delta, .. } => yield Ok(AcpChunk::Delta(delta)),
                AcpMessage::Response { result, .. } => {
                    yield Ok(AcpChunk::Complete(result));
                    break;
                }
                AcpMessage::Error { error, .. } => {
                    yield Err(error.into());
                    break;
                }
            }
        }
    }
}
```

## Notes

- Agents are spawned fresh for each invocation (stateless)
- Long-running agents may be pooled in future
- stderr output from agents appears in rawko's terminal
- Exit code 0 = success, non-zero = failure
- Agent process timeout enforced by rawko
