# Memory Files Conventions

## Overview

Memory files are YAML documents stored in session directories that capture agent-specific discoveries, decisions, and context. They enable:

- **Continuity**: Agent can recall prior attempts and discoveries
- **Debugging**: Human inspection of what agents learned
- **Optimization**: Arbiter makes informed decisions from memory
- **Auditing**: Complete record of reasoning and attempts

## File Structure

```
.rawko/sessions/{sessionId}/
├── context.yaml           # Machine state (see SPEC-0005)
├── conversation.yaml      # Full message history
├── plan.yaml             # Plan evolution
├── metadata.yaml         # Quick reference
└── agent-memory.yaml     # Agent-specific memory (THIS FILE)
```

## Agent Memory Schema

### File Format

```yaml
version: "1"
schema: "agent-memory"

sessionId: "20260123-103000-abc1def2-auth-feature"
agent: "developer"
createdAt: "2026-01-23T10:31:05.000Z"

# ... memory sections below
```

### Discovery Section

Records what the agent has learned about the codebase and task.

```yaml
discoveries:
  - id: "discovery-001"
    timestamp: "2026-01-23T10:31:10.000Z"
    type: "codebase_structure"
    importance: "high"  # low | medium | high | critical
    content: |
      Project uses TypeScript with Deno.
      - src/
        - api/ - Express routes
        - auth/ - Authentication (partially exists)
        - models/ - Data types
      Authentication module exists but incomplete.
      Should extend rather than replace.
    relatedFiles:
      - src/auth/
      - src/api/middleware.ts
    actionItems: []

  - id: "discovery-002"
    timestamp: "2026-01-23T10:31:25.000Z"
    type: "dependency_check"
    importance: "high"
    content: |
      Dependencies available:
      - jsonwebtoken@9.0.0 (for JWT)
      - bcrypt@5.1.0 (for password hashing)
      - express-session@1.17.0 (for sessions)
      
      No additional dependencies needed for basic auth.
    actionItems:
      - "Can proceed without npm install"

  - id: "discovery-003"
    timestamp: "2026-01-23T10:31:45.000Z"
    type: "code_pattern"
    importance: "medium"
    content: |
      Middleware pattern used in project:
      - Express middleware functions
      - Return 401 status on auth failure
      - Pass user info via req.user
      - Use try/catch for errors
    
      This pattern should be followed in auth middleware.
    relatedFiles:
      - src/api/middleware.ts
    actionItems:
      - "Follow existing middleware pattern"
      - "Set req.user for authenticated requests"

  - id: "discovery-004"
    timestamp: "2026-01-23T10:32:15.000Z"
    type: "complexity_assessment"
    importance: "medium"
    content: |
      Task complexity: 5 steps across 3 files
      - Middleware: straightforward, existing pattern
      - Login endpoint: standard implementation
      - Sessions: requires understanding session store
    
      Risk: Session store integration may have gotchas
    actionItems:
      - "Test session store carefully"
      - "May need tester agent for validation"
```

**Discovery Types**:
- `codebase_structure` - Layout and organization
- `dependency_check` - Available libraries and versions
- `code_pattern` - Recurring patterns and conventions
- `api_surface` - Available functions, classes, interfaces
- `data_model` - Schema, types, interfaces
- `complexity_assessment` - Task difficulty and risks
- `failure_cause` - Why previous attempts failed
- `solution_verified` - Approach tested and works

### Attempts Section

Records what the agent has tried, including successes and failures.

```yaml
attempts:
  - id: "attempt-001"
    timestamp: "2026-01-23T10:31:05.000Z"
    planStep: 1
    description: "Implement authentication middleware"
    
    approach: |
      Create src/auth/middleware.ts with:
      - Bearer token validation
      - User extraction from token
      - Error handling
    
    commands:
      - "Create file: src/auth/middleware.ts"
      - "Implement middleware function"
      - "Test with curl"
    
    result: "success"
    output: |
      Created middleware.ts with 45 lines of code.
      Handles JWT validation and passes user to req.user.
      Tested with local curl - working correctly.
    
    artifacts:
      - path: "src/auth/middleware.ts"
        action: "create"
        status: "success"
        content: |
          import jwt from "jsonwebtoken";
          
          export function authMiddleware(req, res, next) {
            ...
          }
    
    duration_ms: 85000
    iterations: 1
    tokensUsed:
      input: 2100
      output: 1230
  
  - id: "attempt-002"
    timestamp: "2026-01-23T10:33:00.000Z"
    planStep: 2
    description: "Implement login endpoint"
    
    approach: |
      Create src/auth/login.ts with:
      - Accept username/password
      - Validate against users
      - Generate JWT token
    
    result: "in_progress"
    status: "working"
    progress: "60%"
    
    subTasks:
      - description: "Create login route"
        status: "complete"
      - description: "Implement password validation"
        status: "complete"
      - description: "Generate JWT token"
        status: "in_progress"
      - description: "Test endpoint"
        status: "pending"
    
    currentIssue: null
    nextStep: "Complete token generation and test"
```

**Attempt Fields**:
- `planStep`: Which step in the plan
- `approach`: What was attempted
- `result`: success | failure | partial | in_progress
- `output`: What happened (for failures, error details)
- `artifacts`: Files created/modified
- `duration_ms`: How long attempt took
- `iterations`: How many iterations within attempt
- `lessons`: What was learned (added on completion)

### Decisions Section

Records significant decisions and reasoning.

```yaml
decisions:
  - id: "decision-001"
    timestamp: "2026-01-23T10:31:00.000Z"
    type: "architectural"
    description: "Choose JWT over session-based auth"
    
    reasoning: |
      - Task explicitly mentions JWT
      - Simpler than session store for MVP
      - Scalable for multi-server deployments
    
    alternatives:
      - name: "Session-based auth"
        reason: "Not chosen - more complex, less scalable"
      - name: "OAuth2"
        reason: "Not chosen - scope too large for this task"
    
    impact: "high"
    reversible: true
    relatedDiscoveries:
      - discovery-002  # dependencies available
      - discovery-003  # code patterns

  - id: "decision-002"
    timestamp: "2026-01-23T10:31:30.000Z"
    type: "implementation"
    description: "Extend existing auth module instead of replacing"
    
    reasoning: |
      - Code already exists at src/auth/
      - Partial implementation provides foundation
      - Consistent with codebase patterns
    
    impact: "medium"
    relatedDiscoveries:
      - discovery-001  # codebase structure
```

**Decision Types**:
- `architectural` - High-level design choices
- `implementation` - Technical approach choices
- `skip` - Intentionally skipped something
- `workaround` - Working around limitation
- `compromise` - Trade-off decision

### Context Section

Current understanding and state.

```yaml
context:
  currentPlanStep: 2
  planStepStatus: "in_progress"
  
  # What files is the agent working with
  filesInScope:
    - path: "src/auth/middleware.ts"
      status: "complete"
      purpose: "Token validation"
    - path: "src/auth/login.ts"
      status: "in_progress"
      purpose: "Login endpoint"
    - path: "src/auth/types.ts"
      status: "pending"
      purpose: "Type definitions"
  
  # Key understanding about the codebase
  codebaseUnderstanding:
    mainLanguage: "TypeScript"
    runtime: "Deno"
    framework: "Express"
    existingPatterns:
      - "Middleware functions"
      - "Error handling with try/catch"
      - "Type safety with interfaces"
  
  # Task-specific context
  taskContext:
    authType: "JWT"
    passwordHashing: "bcrypt"
    tokenExpiration: "24h"
  
  # Known limitations or constraints
  constraints:
    - "No new dependencies allowed (all available)"
    - "Must follow existing patterns"
    - "Session store integration critical"
  
  # What needs validation/testing
  openQuestions:
    - "Session store integration working correctly?"
    - "Password validation following best practices?"
    - "Token refresh strategy needed?"
  
  # Next steps
  nextSteps:
    - "Complete login endpoint implementation"
    - "Create session management functions"
    - "Write integration tests"
  
  blockers: []
  assumptions:
    - "Users table already exists"
    - "Password field is hashed in database"
```

## Memory Management

### When to Update

Update memory files at these points:

1. **On discovery** - New understanding about code/task
   ```
   After reading files → add discovery
   After analyzing patterns → add discovery
   ```

2. **On attempt start** - Before trying something
   ```
   Beginning step → add attempt entry
   Changing approach → update attempt entry
   ```

3. **On attempt completion** - Results and lessons
   ```
   Success → record results
   Failure → record error and root cause
   Partial → record progress
   ```

4. **On decision** - Major choices
   ```
   Choosing architecture → add decision
   Skipping something → add decision
   Working around issue → add decision
   ```

### Memory Usage in Agent Prompts

The agent receives its memory in system context:

```typescript
function buildAgentSystemPrompt(agent: Agent, memory: AgentMemory): string {
  const systemPrompt = agent.systemPrompt;

  const memoryContext = formatMemoryContext(memory);

  return `${systemPrompt}

## Prior Context from This Session

${memoryContext}

Use this context to avoid repeating discoveries or failed approaches.`;
}

function formatMemoryContext(memory: AgentMemory): string {
  let context = "";

  // Add recent discoveries
  const recentDiscoveries = memory.discoveries
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5);
  
  if (recentDiscoveries.length > 0) {
    context += "## Key Discoveries\n";
    for (const d of recentDiscoveries) {
      context += `- [${d.type}] ${d.content.split("\n")[0]}\n`;
    }
  }

  // Add recent failures to avoid
  const recentFailures = memory.attempts
    .filter(a => a.result === "failure")
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 3);
  
  if (recentFailures.length > 0) {
    context += "\n## Recently Failed Approaches (Don't Repeat)\n";
    for (const a of recentFailures) {
      context += `- ${a.description}: ${a.output.split("\n")[0]}\n`;
    }
  }

  // Add current context
  if (memory.context) {
    context += "\n## Current Task Context\n";
    context += `- Step: ${memory.context.currentPlanStep}\n`;
    if (memory.context.blockers.length > 0) {
      context += `- Blockers: ${memory.context.blockers.join(", ")}\n`;
    }
  }

  return context;
}
```

### Arbiter Usage

Arbiter includes memory summaries in its decisions:

```typescript
function buildArbiterSelectPrompt(
  input: SelectAgentInput,
  memories: Map<string, AgentMemory>
): string {
  const previousWork = Array.from(memories.entries())
    .map(([agent, memory]) => {
      const recentAttempt = memory.attempts[memory.attempts.length - 1];
      return `**${agent}**: Last attempt (${recentAttempt.result}) - ${recentAttempt.description}`;
    })
    .join("\n");

  return `
## Previous Agent Work This Session

${previousWork}

Use this to make informed decisions about which agent should work next.
  `;
}
```

## Best Practices

### For Implementing Agents

1. **Frequent Updates**
   - Add discovery for each meaningful finding
   - Record attempt at start and again at completion
   - Update context regularly

2. **Clear Descriptions**
   - Be specific about what was learned
   - Include code snippets for patterns
   - Note file paths for discoveries

3. **Actionable Items**
   - Include next steps in discoveries
   - Mark blockers explicitly
   - Note what needs verification

### For Arbiters

1. **Use Memory Summaries**
   - Check if approach was attempted
   - Verify if discovery exists
   - Look for recurring failures

2. **Make Informed Decisions**
   - Consider past attempts
   - Avoid suggesting failed approaches
   - Build on successful patterns

### For Debugging

1. **Inspect Memory Files**
   ```bash
   cat .rawko/sessions/{sessionId}/agent-memory.yaml
   ```

2. **Trace Decision Path**
   - Find attempt ID in history
   - Find decision referencing that attempt
   - Review reasoning and result

3. **Find Root Causes**
   - Check failure summaries
   - Review related discoveries
   - Look for missed constraints

## Examples

### Example 1: Discovery Flow

```yaml
discoveries:
  - id: "disc-auth-001"
    timestamp: "2026-01-23T10:31:10.000Z"
    type: "codebase_structure"
    importance: "high"
    content: |
      Authentication needs:
      1. Middleware for token validation
      2. Login endpoint for token generation
      3. User/password verification
      
      Existing: src/auth/ directory with some utilities
      Need: Complete middleware and login logic
    
    relatedFiles:
      - src/auth/
      - src/auth/types.ts
      - src/api/middleware.ts
```

### Example 2: Failed Attempt

```yaml
attempts:
  - id: "attempt-oauth"
    timestamp: "2026-01-23T10:35:00.000Z"
    planStep: 2
    description: "Add OAuth2 integration"
    
    approach: |
      Integrate with Google OAuth for authentication
      Simpler than manual password handling
    
    result: "failure"
    error: |
      OAuth scope too broad for task requirements.
      Task specifically asks for JWT-based auth, not OAuth.
      Attempted approach misaligned with requirements.
    
    lessons: |
      - Should have read requirements more carefully
      - OAuth is a viable approach but not for this task
      - Stick to JWT as specified in task
    
    nextAttempt: "Return to JWT implementation"
```

### Example 3: Architecture Decision

```yaml
decisions:
  - id: "dec-jwt-strategy"
    timestamp: "2026-01-23T10:31:00.000Z"
    type: "architectural"
    description: "JWT-based authentication strategy"
    
    reasoning: |
      - Task explicitly requires JWT
      - Available libraries: jsonwebtoken, bcrypt
      - No existing session store infrastructure
      - Simpler for stateless microservices
    
    alternatives:
      - "Session-based auth (complexity vs. simplicity)"
      - "OAuth2 (scope too large)"
      - "API keys (not user-centric)"
    
    impact: "high"
    reversible: false
    relatedDiscoveries:
      - "disc-auth-001"  # codebase structure
      - "disc-deps-001"  # available dependencies
```

## File Size Guidelines

Memory files should be kept reasonably sized:

- **Small session** (< 2 hours): ≤ 50 KB
- **Medium session** (2-4 hours): ≤ 100 KB
- **Long session** (> 4 hours): Archive old entries

When archiving:
1. Keep recent entries (last 2 hours)
2. Summarize older entries into "history" section
3. Move to `agent-memory-archive.yaml`

## Versioning

Memory files use semantic versioning:

```yaml
version: "1"  # Current format version
schema: "agent-memory"
```

When format changes:
- Increment version
- Provide migration guide
- Keep old versions readable

## Validation

Memory files should be valid YAML:

```bash
# Validate syntax
deno run -A --check agent-memory.yaml

# Validate structure
yaml-schema validate agent-memory.yaml agent-memory.schema.yaml
```

## Integration Points

Memory files are read/written at:

1. **Agent initialization** - Load memory context
2. **During execution** - Update in real-time
3. **On completion** - Final session record
4. **Arbiter decisions** - Reference for context
5. **Debugging** - Human inspection
