# ADR-0005: Capability-based Security

## Status

Accepted

## Context

rawko agents can execute tools that interact with the filesystem, run shell commands, and access external services. This creates security concerns:

- Agents could access files outside intended scope
- Shell commands could be malicious or destructive
- LLM outputs are unpredictable
- Agents might request unintended capabilities

We need a security model that:
- Limits agent capabilities to what's necessary
- Prevents privilege escalation
- Makes permissions explicit and auditable
- Works with the LLM agent model

Security models considered:
- Capability-based security
- Role-based access control (RBAC)
- Mandatory access control (MAC)
- No restrictions (trust the LLM)

## Decision

We will implement capability-based security where agents only receive tools they explicitly declare in their definitions.

## Consequences

### Positive

**Principle of Least Privilege**
- Agents only get tools they need
- Reduces attack surface
- Limits blast radius of misbehavior
- Clear capability boundaries

**Explicit Permissions**
- Tool access declared in agent definitions
- Auditable from configuration
- No hidden capabilities
- Easy to review and understand

**Defense in Depth**
- LLM can't request undeclared tools
- Even if prompt injection occurs, capabilities limited
- Multiple layers of protection
- Reduces insider threat

**Composable Security**
- Different agents have different capabilities
- Security policy distributed with agent definitions
- Project overrides can restrict further
- Easy to add new restricted agents

**Auditability**
- Clear record of what each agent can do
- Tool calls logged with agent context
- Easy to trace capability usage
- Compliance-friendly

### Negative

**Configuration Burden**
- Must explicitly declare every tool
- Easy to forget needed capabilities
- More verbose agent definitions
- Requires understanding tool categories

**Flexibility Limitations**
- Agents can't dynamically request tools
- New capabilities need definition update
- May need to restart for permission changes
- Less adaptive than unrestricted model

**Doesn't Prevent All Attacks**
- Shell tool is still powerful if granted
- Filesystem access can still be misused
- Social engineering via LLM still possible
- Not a complete security solution

**False Sense of Security**
- Tool restrictions don't prevent all harm
- Shell commands can do almost anything
- LLM output to user could be malicious
- Must combine with other safeguards

## Alternatives Considered

### No Restrictions (Trust LLM)

Let agents request any tool.

Pros:
- Simplest implementation
- Maximum flexibility
- No configuration overhead

Cons:
- Single failure point
- LLM could be manipulated
- No defense in depth
- Inappropriate for sensitive environments

Rejected because: Security risk too high for a tool that runs shell commands.

### Role-based Access Control

Define roles with fixed capability sets.

Pros:
- Familiar model
- Standardized roles
- Easy to understand

Cons:
- Less granular
- Roles may not match agent needs
- Extra abstraction layer
- Harder to customize

Not chosen because: Capability-based is more flexible and maps directly to agent definitions.

### Mandatory Access Control

Kernel-level restrictions (SELinux/AppArmor).

Pros:
- OS-enforced security
- Very strong guarantees
- Can't be bypassed by application

Cons:
- Complex configuration
- OS-specific
- Requires elevated setup
- Overkill for this use case

Rejected because: Too complex for user-facing tool, not cross-platform.

### Sandboxing (Containers/VMs)

Run agents in isolated environments.

Pros:
- Strong isolation
- Limited system access
- Defense in depth

Cons:
- Significant overhead
- Complex setup
- Slower execution
- Harder to access local files

Deferred: May add as optional feature for high-security environments.

## Implementation

### Agent Definition

```yaml
name: developer
tools:
  - filesystem    # Can read/write/list files
  - shell         # Can run commands
  - git           # Can use git operations
```

### Tool Registry Enforcement

```rust
pub struct ToolRegistry {
    available_tools: HashMap<String, Tool>,
}

impl ToolRegistry {
    pub fn get_tools_for_agent(&self, agent: &AgentDef) -> Vec<&Tool> {
        agent.tools
            .iter()
            .filter_map(|name| self.available_tools.get(name))
            .collect()
    }

    pub fn execute_tool(
        &self,
        agent: &AgentDef,
        tool_name: &str,
        params: Value
    ) -> Result<ToolResult> {
        // Check capability
        if !agent.tools.contains(&tool_name) {
            return Err(Error::CapabilityDenied {
                agent: agent.name.clone(),
                tool: tool_name.to_string(),
            });
        }

        // Execute if allowed
        self.available_tools
            .get(tool_name)
            .ok_or(Error::ToolNotFound(tool_name.to_string()))?
            .execute(params)
    }
}
```

### Additional Restrictions

Beyond tool-level capabilities, we implement:

1. **Path restrictions**: Filesystem tools scoped to project directory
2. **Command allowlists**: Optional shell command restrictions
3. **Network policies**: Optional URL/host restrictions for HTTP tools
4. **Resource limits**: Timeouts and output size limits

## Notes

- Capability enforcement happens at tool execution time
- Denied capability attempts are logged and traced
- Future: user confirmation for sensitive operations
- Future: runtime capability grants for specific operations
