# ADR-0008: CUE Configuration

## Status

Accepted

## Context

rawko needs a configuration system for:

- Global settings (LLM providers, defaults)
- Project-specific overrides
- Agent definitions (fully integrated in CUE)
- Tool configurations
- Observability settings

Configuration requirements:
- Type safety to catch errors early
- Readable and writable by humans
- Support for validation
- Composable (global + project layers)
- Good Rust integration

Configuration formats considered:
- CUE
- TOML
- YAML
- JSON
- Dhall
- Nickel

## Decision

We will use CUE for all configuration files, including agent definitions, leveraging the `cuengine` crate for Rust integration.

## Consequences

### Positive

**Type Safety**
- Schema-defined types
- Validation at load time
- Clear error messages
- No runtime surprises

**Composability**
- Merge global and project configs
- Override specific values
- Inherit defaults naturally
- Layer configurations

**Constraints**
- Define valid ranges
- Express relationships
- Required vs optional
- Pattern matching

**Expressiveness**
- Comprehensions for lists
- String interpolation
- Conditional values
- Template-like definitions

**Rust Integration**
- cuengine crate provides evaluation
- Serde integration for deserialization
- Compile-time type generation possible
- Active development

**Self-Documenting**
- Types serve as documentation
- Clear structure
- Exportable schemas
- IDE support improving

**Unified Configuration**
- Agents defined alongside other config
- Single source of truth
- No format switching between config and agents
- Easier to understand overall structure

### Negative

**Learning Curve**
- CUE is less known than TOML/YAML
- Different mental model
- Documentation still maturing
- Fewer examples available

**Tooling**
- Editor support varies
- Syntax highlighting limited
- Debugging can be tricky
- Error messages sometimes unclear

**Rust Ecosystem**
- cuengine is relatively new
- Fewer examples in Rust
- May need contributions upstream
- Dependency on external engine

**Complexity for Simple Cases**
- Overhead for basic configs
- CUE features may be unused
- Users must learn new format
- Migration from TOML/YAML

## Alternatives Considered

### TOML

The Rust community default.

Pros:
- Rust ecosystem standard
- Excellent Rust support
- Simple and familiar
- Good tooling

Cons:
- No schema/validation built-in
- Limited expressiveness
- No composition model
- Flat structure

Not chosen because: Lacks type safety and composition features.

### YAML

Common in DevOps/cloud native.

Pros:
- Very widely known
- Good for complex structures
- Many tools support it
- Mature ecosystem

Cons:
- No types/validation
- Whitespace sensitivity errors
- Security concerns (YAML bombs)
- Many dialects

Not chosen because: Safety and validation concerns.

### JSON

Universal data format.

Pros:
- Universal support
- Well-defined spec
- No ambiguity
- Great tooling

Cons:
- No comments
- Verbose
- No trailing commas
- Not human-friendly for editing

Rejected because: Poor ergonomics for hand-written configuration.

### Dhall

Typed configuration language.

Pros:
- Strong types
- Functional style
- Guaranteed termination
- Good composition

Cons:
- Very niche
- Limited tooling
- Steep learning curve
- No Rust crate maturity

Rejected because: Even less known than CUE, worse Rust support.

### Nickel

Configuration language from Tweag.

Pros:
- Designed for configuration
- Contract system
- Good error messages
- Modern design

Cons:
- Very new
- Limited adoption
- No stable Rust bindings
- Small community

Not chosen because: Too new, ecosystem not ready.

## Implementation

### Configuration Schema

```cue
package rawko

#Config: {
    // LLM provider configurations
    providers: [string]: #Provider

    // Default provider for arbiter
    arbiter: #ArbiterConfig

    // Tool configurations
    tools: #ToolsConfig

    // Observability settings
    observability: #ObservabilityConfig

    // State persistence
    state: #StateConfig

    // Agent definitions (inline)
    agents: [string]: #Agent
}

#Provider: {
    type:     "anthropic" | "openai" | "ollama"
    api_key?: string
    base_url?: string
    models: [...string]
}

#ArbiterConfig: {
    provider: string
    model:    string
    max_iterations: int | *50
    temperature: float | *0.7
}

#ToolsConfig: {
    shell: #ShellConfig
    filesystem: #FilesystemConfig
}

#ShellConfig: {
    timeout_seconds: int | *30
    allowed_commands?: [...string]
    blocked_commands?: [...string]
    working_directory?: string
}

#FilesystemConfig: {
    root:      string | *"."
    allowed_extensions?: [...string]
    max_file_size_bytes: int | *10485760
    gitignore_aware: bool | *true
}

#ObservabilityConfig: {
    terminal: #TerminalConfig
    otel?: #OtelConfig
}

#TerminalConfig: {
    enabled:   bool | *true
    verbosity: "quiet" | "default" | "verbose" | "debug" | *"default"
    colors: bool | *true
    progress_indicators: bool | *true
}

#OtelConfig: {
    enabled:  bool | *false
    endpoint?: string
    service_name: string | *"rawko"
    sample_rate: float | *1.0
}

#StateConfig: {
    retention_days: int | *30
    max_tasks: int | *1000
    persist_path?: string
}

#Agent: {
    name: =~"^[a-z][a-z0-9-]*$"
    description: string & !=""

    model_hints?: {
        prefer?: [...string]
        avoid?: [...string]
    }

    tools?: [...#ToolCategory]

    mcp_servers?: [...{
        name: string
        command: string
        args?: [...string]
        env?: [string]: string
    }]

    transitions?: [...string]
    timeout?: string | *"5m"
    max_tool_calls?: int | *50

    system_prompt: string & !=""
}

#ToolCategory: "filesystem" | "shell" | "git" | "mcp"
```

### Example Configuration

```cue
// ~/.config/rawko/config.cue
package rawko

providers: {
    anthropic: {
        type:    "anthropic"
        api_key: "${ANTHROPIC_API_KEY}"
        models: ["claude-3-opus-20240229", "claude-3-sonnet-20240229"]
    }
    openai: {
        type:    "openai"
        api_key: "${OPENAI_API_KEY}"
        models: ["gpt-4-turbo", "gpt-4"]
    }
}

arbiter: {
    provider: "anthropic"
    model:    "claude-3-sonnet-20240229"
}

tools: {
    shell: {
        timeout_seconds: 60
        blocked_commands: ["rm -rf /", "sudo"]
    }
}

observability: {
    terminal: verbosity: "default"
}

agents: {
    developer: {
        name: "developer"
        description: "Writes and modifies code based on requirements"
        tools: ["filesystem", "shell", "git"]
        transitions: ["reviewer", "debugger"]
        system_prompt: """
            # Developer Agent

            You are a senior software developer working on a codebase.
            Your role is to write, modify, and improve code based on
            requirements and feedback.

            ## Guidelines

            - Write clean, maintainable code following project conventions
            - Include appropriate error handling
            - Add comments only where logic is non-obvious
            - Prefer simple solutions over clever ones
            """
    }
    reviewer: {
        name: "reviewer"
        description: "Reviews code changes for quality"
        tools: ["filesystem", "git"]
        transitions: ["developer"]
        system_prompt: """
            # Code Reviewer

            You review code changes for quality, correctness, and
            adherence to best practices.
            """
    }
}
```

### Project Override

```cue
// .rawko/config.cue
package rawko

tools: shell: timeout_seconds: 300  // Allow longer commands for this project

observability: terminal: verbosity: "verbose"  // More detail

// Project-specific agent override
agents: developer: {
    name: "developer"
    description: "Project-specific developer with custom tools"
    tools: ["filesystem", "shell", "git", "mcp"]
    mcp_servers: [{
        name: "github"
        command: "github-mcp-server"
        args: ["--token", "${GITHUB_TOKEN}"]
    }]
    transitions: ["reviewer"]
    system_prompt: """
        # Developer Agent (Project-Specific)

        You are a developer for this specific project...
        """
}
```

### Rust Loading

```rust
use cuengine::{Context, Value};

pub fn load_config() -> Result<Config> {
    let ctx = Context::new();

    // Load global config
    let global = dirs::config_dir()
        .map(|p| p.join("rawko/config.cue"))
        .filter(|p| p.exists());

    // Load project config
    let project = Path::new(".rawko/config.cue");

    // Merge configs
    let value = ctx.compile_files(&[global, Some(project)])?;

    // Deserialize to Rust struct
    let config: Config = value.decode()?;

    Ok(config)
}
```

## Notes

- All configuration uses CUE format consistently
- Environment variable substitution via `${VAR}` syntax
- Schema exported for editor validation
- Agent definitions are part of the unified config, not separate files
