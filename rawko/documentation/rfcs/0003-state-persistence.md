# RFC-0003: State Persistence

## Abstract

This RFC specifies how rawko persists task and conversation state locally. State persistence enables task resumption, history browsing, and debugging. The system stores state in human-readable files within the project directory, supporting queries and configurable retention.

## Motivation

Persistent state serves multiple purposes:

1. **Task resumption**: Continue interrupted work
2. **Context preservation**: Maintain conversation history across sessions
3. **Debugging**: Inspect what happened during task execution
4. **Learning**: Review past interactions for improvement
5. **Audit trail**: Record of agent actions and decisions

Without persistence:
- Interrupted tasks must restart from scratch
- No visibility into past agent behavior
- Difficult to debug failures

## Detailed Design

### Storage Location

State is stored in the project directory:

```
./.rawko/
├── state/
│   ├── tasks/
│   │   ├── 2024-01-15T10-30-00-abc123.task
│   │   └── 2024-01-15T14-22-00-def456.task
│   └── index.db              # SQLite index for queries
└── config.cue                # Project configuration (includes agents)
```

### Task File Format

Each task is stored as a structured text file:

```
=== TASK abc123 ===
Created: 2024-01-15T10:30:00Z
Status: completed
Duration: 45.2s

=== REQUEST ===
User: Fix the login bug where users can't authenticate with SSO

=== EXECUTION ===

--- Turn 1: arbiter ---
Selected: planner
Reason: Task requires understanding before implementation

--- Turn 2: planner ---
Status: complete
Duration: 8.3s
Tool Calls: 5

[Content]
After analyzing the codebase, the login issue appears to be in the SSO
callback handler. Here's the plan:
1. Fix the token validation in auth/sso.rs
2. Add proper error handling for expired tokens
3. Update the tests

[Tool Log]
10:30:05 filesystem.read auth/sso.rs -> 2048 bytes
10:30:06 filesystem.read auth/mod.rs -> 1024 bytes
10:30:07 filesystem.search "SSO" -> 3 matches
10:30:08 filesystem.read tests/auth_test.rs -> 512 bytes
10:30:09 filesystem.read config/auth.toml -> 256 bytes

--- Turn 3: arbiter ---
Selected: developer
Reason: Plan is clear, ready for implementation

--- Turn 4: developer ---
Status: complete
Duration: 23.1s
Tool Calls: 12

[Content]
I've fixed the SSO authentication issue:
- Updated token validation to handle clock skew
- Added proper error messages for expired tokens
- Fixed the callback URL construction

[Tool Log]
10:30:15 filesystem.read auth/sso.rs -> 2048 bytes
10:30:18 filesystem.write auth/sso.rs -> 2156 bytes
10:30:20 shell.exec "cargo check" -> exit 0
10:30:35 shell.exec "cargo test auth" -> exit 0
...

--- Turn 5: arbiter ---
Selected: reviewer
Reason: Code changes need review

--- Turn 6: reviewer ---
Status: complete
Duration: 10.2s
Tool Calls: 4

[Content]
Code review passed. Changes look good:
- Token validation fix is correct
- Error handling is appropriate
- Tests cover the new cases

--- Turn 7: arbiter ---
Decision: complete
Reason: Task successfully completed, reviewer approved

=== RESULT ===
Status: success
Summary: Fixed SSO authentication by correcting token validation timing
Files Modified:
  - auth/sso.rs
  - tests/auth_test.rs
```

### File Naming

Task files use timestamp-based naming:

```
{ISO-timestamp}-{short-id}.task
2024-01-15T10-30-00-abc123.task
```

- Timestamp enables chronological sorting via filename
- Short ID (6 chars) provides uniqueness
- `.task` extension identifies file type

### Index Database

An SQLite database provides efficient querying:

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP,
    completed_at TIMESTAMP,
    status TEXT,           -- pending, running, completed, failed
    duration_ms INTEGER,
    request TEXT,
    result_summary TEXT,
    file_path TEXT
);

CREATE TABLE task_agents (
    task_id TEXT,
    turn INTEGER,
    agent TEXT,
    status TEXT,
    duration_ms INTEGER,
    tool_calls INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE task_files (
    task_id TEXT,
    file_path TEXT,
    operation TEXT,        -- read, write, delete
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_tasks_created ON tasks(created_at);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_task_files_path ON task_files(file_path);
```

### Query Language

CLI commands for querying state:

```bash
# List recent tasks
rawko history
rawko history --limit 20
rawko history --status failed

# Search tasks
rawko history --search "SSO"
rawko history --file "auth/sso.rs"
rawko history --agent developer

# View specific task
rawko history show abc123

# Resume task
rawko resume abc123

# Export task
rawko history export abc123 --format json
```

### State Operations

#### Creating State

When a task starts:
1. Generate unique task ID
2. Create task file with header
3. Insert index record with `status=running`

#### Updating State

As execution progresses:
1. Append turn data to task file
2. Update index with agent records
3. Flush after each turn (crash safety)

#### Completing State

When task finishes:
1. Append result section to task file
2. Update index with final status
3. Record completion timestamp

#### Resuming State

To resume an interrupted task:
1. Load task file
2. Reconstruct conversation context
3. Resume from last arbiter decision point

### Retention Policy

Configurable cleanup of old state:

```cue
state: {
    retention: {
        max_age: "30d"           // Delete tasks older than 30 days
        max_count: 1000          // Keep at most 1000 tasks
        keep_failed: true        // Always keep failed tasks
        min_keep: 10             // Always keep at least 10 recent
    }
}
```

Cleanup runs:
- On rawko startup
- Daily if rawko runs as daemon
- Manual via `rawko cleanup`

### Privacy Considerations

State files may contain:
- User prompts (possibly sensitive)
- File contents (possibly proprietary)
- Command outputs (possibly containing secrets)

Mitigations:
- State stored in project directory (project-level access control)
- `.rawko/` added to default `.gitignore` suggestions
- Optional encryption for state files (future)
- Redaction patterns for known secret formats (future)

## Drawbacks

1. **Disk usage**: Long-running projects accumulate state
2. **Performance**: Large task files slow to parse
3. **Privacy**: Sensitive data in plaintext files
4. **Complexity**: Two storage formats (file + SQLite)

## Alternatives

### Pure SQLite

Store everything in SQLite. Rejected because:
- Binary format not human-readable
- Harder to inspect/debug
- Can't easily share individual tasks

### Pure File-based

No index database. Rejected because:
- Slow queries on large history
- Complex search implementation
- No efficient filtering

### External Database

Use PostgreSQL or similar. Rejected because:
- Adds deployment complexity
- Overkill for local tool
- Network dependency

### JSON Format

Use JSON for task files. Not chosen because:
- Less readable for long conversations
- Harder to append incrementally
- Custom format is more compact

## Unresolved Questions

1. **Encryption**: How to handle encrypted state?
2. **Sync**: Should state sync across machines?
3. **Compression**: Compress old task files?
4. **Streaming**: How to handle very long tasks?
5. **Partial resume**: Resume from specific turn?
