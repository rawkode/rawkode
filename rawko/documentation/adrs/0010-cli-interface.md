# ADR-0010: CLI Interface

## Status

Accepted

## Context

rawko is primarily used via command line. The CLI must:

- Accept task descriptions naturally
- Show progress during execution
- Stream agent outputs
- Support configuration and history
- Be intuitive for developers

Interface options considered:
- Traditional CLI with subcommands
- REPL/interactive mode
- TUI (terminal UI)
- GUI application
- Web interface

## Decision

We will implement a traditional CLI with streaming terminal output, prioritizing simplicity and Unix philosophy integration.

## Consequences

### Positive

**Unix Philosophy**
- Composable with other tools
- Scriptable in shell
- Pipes and redirects work
- Familiar to developers

**Simplicity**
- No complex UI framework
- Fast startup
- Low resource usage
- Easy to maintain

**Streaming Output**
- Real-time progress visibility
- Agent output as it happens
- Responsive feel
- No waiting for completion

**Scriptability**
- Exit codes for automation
- Parseable output modes
- Environment variable config
- CI/CD friendly

**Accessibility**
- Works in any terminal
- SSH-friendly
- Screen reader compatible
- No graphics required

### Negative

**Limited Interactivity**
- No mid-task user input (initially)
- Can't easily modify running tasks
- History browsing is basic
- No visual workflow view

**Output Complexity**
- Streaming can be noisy
- Hard to show multiple agents
- Progress visualization limited
- Color handling varies

**Discovery**
- Features less discoverable
- Must read help text
- No GUI to explore
- Learning curve for options

## Alternatives Considered

### REPL/Interactive Mode

Persistent interactive session.

Pros:
- Continuous conversation
- Context preservation
- More natural dialogue
- Quick follow-ups

Cons:
- Different from typical CLI
- Session management complex
- History across sessions
- Exit behavior unclear

Deferred: May add as secondary mode later.

### TUI (Terminal UI)

Rich terminal interface (like vim, htop).

Pros:
- Rich visualization
- Multiple panes
- Real-time updates
- Interactive

Cons:
- Complex implementation
- Not scriptable
- Accessibility concerns
- Harder to pipe output

Rejected for primary interface because: Loses composability, but may add optional mode.

### GUI Application

Desktop application with visual interface.

Pros:
- Rich visualization
- Easy to use
- Visual workflow
- Point and click

Cons:
- Platform-specific
- More code to maintain
- Can't use in SSH
- Separate project scope

Rejected because: Out of scope for CLI tool, could be separate project.

### Web Interface

Browser-based UI.

Pros:
- Cross-platform
- Rich interface possible
- Easy to share
- Modern feel

Cons:
- Requires server
- Browser dependency
- Authentication complexity
- Different deployment model

Rejected because: Adds significant complexity, changes deployment model.

## Implementation

### Command Structure

```bash
rawko [OPTIONS] <COMMAND>

Commands:
  task      Execute a task (default)
  history   View task history
  resume    Resume an interrupted task
  config    Manage configuration
  agents    List and manage agents

Options:
  -v, --verbose    Increase verbosity (-v, -vv, -vvv)
  -q, --quiet      Suppress non-error output
  --json           Output in JSON format
  --no-color       Disable color output
  -c, --config     Config file path
```

### Primary Usage

```bash
# Simple task
rawko "fix the login bug"

# Explicit task command
rawko task "implement user authentication"

# With options
rawko -v "add dark mode support"

# JSON output for scripts
rawko --json "list all API endpoints"
```

### Streaming Output

```
$ rawko "fix the authentication bug in login.rs"

[10:30:00] Task started
[10:30:01] → Arbiter: Analyzing task...
[10:30:02] → Arbiter: Selected planner
[10:30:03] → Planner: Reading codebase...
           Reading src/auth/login.rs
           Reading src/auth/mod.rs
[10:30:10] ← Planner: Complete
           Found issue in token validation

[10:30:11] → Arbiter: Selected developer
[10:30:12] → Developer: Implementing fix...
           Modifying src/auth/login.rs
           Running cargo check
[10:30:25] ← Developer: Complete
           Fixed token expiry comparison

[10:30:26] → Arbiter: Task complete
[10:30:26] Done in 26s

Modified files:
  - src/auth/login.rs
```

### Progress Indicators

Using `indicatif` for progress:

```rust
use indicatif::{ProgressBar, ProgressStyle};

let spinner = ProgressBar::new_spinner();
spinner.set_style(
    ProgressStyle::default_spinner()
        .template("{spinner:.green} {msg}")
        .unwrap()
);
spinner.set_message("Analyzing task...");

// During execution
spinner.set_message("Reading files...");

// On completion
spinner.finish_with_message("Done");
```

### Output Modes

```rust
pub enum OutputMode {
    /// Human-readable streaming (default)
    Human {
        color: bool,
        verbosity: Verbosity,
    },
    /// JSON lines for scripts
    Json,
    /// Minimal output (errors only)
    Quiet,
}

impl OutputMode {
    pub fn emit_event(&self, event: &Event) {
        match self {
            OutputMode::Human { color, verbosity } => {
                // Pretty print based on verbosity
            }
            OutputMode::Json => {
                println!("{}", serde_json::to_string(event).unwrap());
            }
            OutputMode::Quiet => {
                if event.is_error() {
                    eprintln!("{}", event);
                }
            }
        }
    }
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Task failed |
| 2 | Configuration error |
| 3 | Agent error |
| 4 | User cancelled |
| 5 | Network/API error |

### History Commands

```bash
# List recent tasks
rawko history
rawko history --limit 20
rawko history --status failed

# Search history
rawko history --search "authentication"
rawko history --file "src/auth"

# View specific task
rawko history show abc123

# Resume task
rawko resume abc123
```

### Configuration Commands

```bash
# Show current config
rawko config show

# Set value
rawko config set observability.terminal.verbosity verbose

# Edit in $EDITOR
rawko config edit

# Show config path
rawko config path
```

## Notes

- Default output targets stderr for progress, stdout for results
- Color detection via `supports-color` crate
- Terminal width detection for formatting
- Ctrl+C handling for graceful shutdown
- Consider adding `--dry-run` for task preview
