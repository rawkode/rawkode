# RFC-0002: Agent Definition Format

## Abstract

This RFC specifies the format for defining agents in rawko. Agents are defined as CUE structs within the unified configuration file, combining structured metadata with system prompts. This format provides type safety, validation, and seamless integration with the existing CUE-based configuration system.

## Motivation

Agent definitions need to capture:
1. **Metadata**: Name, description, model preferences, tool access
2. **Behavior**: System prompt defining how the agent operates
3. **Constraints**: Valid transitions, capability limits

A unified CUE format provides:
- Type-safe schema validation
- Seamless integration with project configuration
- Single source of truth for all rawko settings
- IDE support and editor validation
- Version control friendly (plain text)

## Detailed Design

### Configuration Location

Agents are defined within the unified CUE configuration:

```
./.rawko/config.cue    # Contains both config and agents
```

The `#Config` type includes an `agents` field that maps agent names to their definitions.

### Agent Definition Structure

```cue
#Agent: {
    // Required: unique identifier, lowercase alphanumeric + hyphens
    name: =~"^[a-z][a-z0-9-]*$"

    // Required: brief description for arbiter context
    description: string & !=""

    // Optional: model preferences (advisory, not enforced)
    model_hints?: {
        prefer?: [...string]
        avoid?: [...string]
    }

    // Optional: tool categories this agent can access
    tools?: [...#ToolCategory]

    // Optional: MCP server configurations
    mcp_servers?: [...{
        name: string
        command: string
        args?: [...string]
        env?: [string]: string
    }]

    // Optional: valid next agents (by name)
    transitions?: [...string]

    // Optional: max execution time (default: 5m)
    timeout?: string | *"5m"

    // Optional: max tool invocations per turn (default: 50)
    max_tool_calls?: int | *50

    // Required: system prompt defining agent behavior
    system_prompt: string & !=""
}

#ToolCategory: "filesystem" | "shell" | "git" | "mcp"
```

### Example Configuration

```cue
// .rawko/config.cue
package rawko

providers: {
    anthropic: {
        type: "anthropic"
        api_key: "${ANTHROPIC_API_KEY}"
        models: ["claude-sonnet-4-20250514"]
    }
}

arbiter: {
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
}

agents: {
    developer: {
        name: "developer"
        description: "Writes and modifies code based on requirements"
        model_hints: {
            prefer: ["claude-3-opus", "gpt-4"]
            avoid: ["gpt-3.5-turbo"]
        }
        tools: ["filesystem", "shell", "git"]
        mcp_servers: [{
            name: "github"
            command: "github-mcp-server"
            args: ["--token", "${GITHUB_TOKEN}"]
        }]
        transitions: ["reviewer", "planner", "debugger"]
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

            ## Process

            1. Understand the requirement or issue
            2. Explore relevant code to understand context
            3. Plan your changes
            4. Implement incrementally, testing as you go
            5. Verify your changes work correctly

            ## Tool Usage

            - Use filesystem tools to read and understand existing code
            - Use shell for running tests and builds
            - Use git to check status and create commits when asked
            """
    }
}
```

### Field Specifications

#### `name`

- Must be unique across all loaded agents
- Lowercase letters, numbers, hyphens only
- Used as FSM state identifier
- Examples: `developer`, `code-reviewer`, `test-runner`

#### `description`

- Used by arbiter for agent selection
- Should clearly convey the agent's purpose
- Keep concise (1-2 sentences)

#### `model_hints`

Advisory preferences for model selection:

```cue
model_hints: {
    prefer: ["claude-3-opus", "gpt-4"]  // Priority order
    avoid: ["gpt-3.5-turbo"]            // Not suitable for this role
}
```

The runtime may ignore hints based on availability and configuration.

#### `tools`

Tool categories available to the agent:

| Category | Capabilities |
|----------|-------------|
| `filesystem` | read, write, list, search, delete files |
| `shell` | execute commands, capture output |
| `git` | status, diff, add, commit, log, branch operations |
| `mcp` | tools from configured MCP servers |

Agents can only invoke tools from declared categories.

#### `mcp_servers`

MCP server configurations specific to this agent:

```cue
mcp_servers: [{
    name: "github"
    command: "github-mcp-server"
    args: ["--token", "${GITHUB_TOKEN}"]
    env: {
        GITHUB_API_URL: "https://api.github.com"
    }
}]
```

Environment variable substitution uses `${VAR_NAME}` syntax.

#### `transitions`

Declares valid next agents:

```cue
transitions: ["reviewer", "debugger"]
```

- Empty list means agent can only return control to arbiter
- Arbiter uses these constraints when routing
- Transitions outside this list are rejected

#### `timeout`

Maximum time for agent execution:

```cue
timeout: "10m"
```

- Default: 5 minutes
- Agent is terminated if exceeded
- Treated as failure for routing purposes

#### `max_tool_calls`

Limits tool invocations per agent turn:

```cue
max_tool_calls: 100
```

- Default: 50
- Prevents runaway tool loops
- Counted per arbiter→agent→arbiter cycle

#### `system_prompt`

The system prompt defining agent behavior:

```cue
system_prompt: """
    # Agent Role

    You are a specialized agent...

    ## Guidelines

    - Specific instructions
    - Behavioral guidelines
    """
```

- Multi-line strings use CUE's `"""` syntax
- Should define agent personality and behavior
- Can include examples and guidelines
- Rendered as-is to the LLM

Best practices:
- Use headers to organize sections
- Include specific guidelines for common situations
- Define how to handle edge cases
- Specify tool usage patterns

### Validation Rules

On load, each agent definition is validated:

1. **Required fields**: `name`, `description`, and `system_prompt` must be present
2. **Name uniqueness**: No duplicate names
3. **Name format**: Matches `^[a-z][a-z0-9-]*$`
4. **Tool validity**: All tools in known categories
5. **Transition validity**: All transitions reference existing agents
6. **MCP commands**: Commands must be valid paths or in PATH
7. **Prompt presence**: System prompt must not be empty

Validation failures prevent rawko from starting.

### Example Agents

#### Planner Agent

```cue
agents: {
    planner: {
        name: "planner"
        description: "Analyzes tasks and creates implementation plans"
        model_hints: prefer: ["claude-3-opus"]
        tools: ["filesystem"]
        transitions: ["developer", "researcher"]
        system_prompt: """
            # Planner Agent

            You create detailed implementation plans for software tasks.

            ## Process

            1. Understand the task requirements
            2. Explore the codebase to understand context
            3. Identify affected components
            4. Create a step-by-step plan
            5. Note any risks or uncertainties

            ## Output Format

            Provide plans as numbered steps with clear actions.
            """
    }
}
```

#### Reviewer Agent

```cue
agents: {
    reviewer: {
        name: "reviewer"
        description: "Reviews code changes for quality and correctness"
        tools: ["filesystem", "git"]
        transitions: ["developer"]
        system_prompt: """
            # Code Reviewer

            You review code changes for quality, correctness, and
            adherence to best practices.

            ## Review Criteria

            - Correctness: Does it do what it should?
            - Clarity: Is the code readable?
            - Safety: Are there security concerns?
            - Tests: Is it adequately tested?

            ## Output

            Provide specific, actionable feedback with file/line references.
            """
    }
}
```

### Agent Loading and Merging

Agents are loaded from multiple sources with the following precedence (later overrides earlier):

1. **Built-in agents**: Embedded in the rawko binary
2. **Global config**: `~/.config/rawko/config.cue`
3. **Project config**: `.rawko/config.cue`

This allows:
- Sensible defaults from built-in agents
- User-customized default agents in global config
- Project-specific agent overrides

## Drawbacks

1. **Multi-line strings**: CUE's `"""` syntax may be unfamiliar
2. **Validation timing**: Errors only caught at startup, not edit time
3. **No inheritance**: Agents can't extend other agents (though CUE allows composition patterns)

## Alternatives

### YAML Frontmatter + Markdown (Previous Approach)

Separate metadata and prompt in markdown files with YAML frontmatter. Not chosen because:
- Two formats to learn and maintain
- No schema validation for YAML
- Separate files from main config
- More complex loading logic

### Pure YAML/JSON

Separate config and prompt files. Rejected because:
- Two files to manage per agent
- Easy to desync config and prompt
- No type safety or validation
- Less expressive than CUE

### Code-based Definition

Define agents in Rust code. Rejected because:
- Requires recompilation for changes
- Less accessible to non-developers
- Harder to version per-project

### Separate CUE Files per Agent

One `.cue` file per agent in a directory. Not chosen because:
- More file management
- Loses benefits of unified config
- Harder to see all agents at once
- CUE already handles composition well

## Unresolved Questions

1. **Agent inheritance**: Should agents be able to extend others via CUE embedding?
2. **Conditional tools**: Tools based on project context?
3. **Dynamic prompts**: Template variables in prompt body?
4. **Versioning**: How to handle agent definition updates?
