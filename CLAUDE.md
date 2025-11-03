# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

rawkOS is a Bun workspace monorepo containing:
- **dhd/** - `@rawkode/dhd` framework package (~600 LOC) - reusable declarative dotfile manager
- **rawkOS/** - Personal dotfiles configuration using dhd

## Development Commands

```bash
# Install dependencies
bun install

# Apply all modules from rawkOS/
cd rawkOS && bunx dhd

# Apply specific modules
bunx dhd -- starship fish

# Dry run (see what would execute)
bunx dhd --dry-run
```

**No build step required** - Bun runs TypeScript directly.

## Core Architecture

### Module Execution Pipeline

The framework follows a strict separation between planning and execution:

```
CLI (cli.ts)
  ↓
Module Discovery (glob **/mod.{ts,js})
  ↓
Dependency Resolution (topological sort via DFS)
  ↓
Condition Evaluation (when gates with Ctx)
  ↓
Planning Phase (plan.ts)
  - Converts Actions → PlanOps
  - Resolves source() paths using _modulePath
  - Handles HTTP downloads to cache
  ↓
Sudo Validation (single upfront prompt if needed)
  ↓
Execution Phase (exec.ts)
  - Executes all PlanOps sequentially
```

**Key insight**: All operations are planned before any execution starts. This enables:
- Single sudo password prompt upfront
- Async execution preparation
- Clear separation of concerns

### Path Resolution (Two-Phase)

Paths use a deferred resolution strategy to enable zero-boilerplate:

**Phase 1 - Module Definition Time**:
```typescript
source("config.fish")  // Returns { kind: "Source", relativePath: "config.fish" }
```

**Phase 2 - Planning Time**:
```typescript
// Uses module._modulePath set during discovery
resolveSourcePath(source, moduleDir)  // Returns absolute path
```

This allows modules to use relative paths without manual `import.meta.url` handling.

**Safety validations** (`dhd/src/paths.ts`):
- `source()` paths cannot escape module directory (via `path.relative()` check)
- `userPath()` must be under `$HOME`
- `systemPath()` must be absolute
- `http()` supports optional SHA256 integrity verification

### Action Types and PlanOps

Actions are high-level declarations that get converted to low-level operations:

**Action → PlanOp conversions** (`dhd/src/plan.ts`):
```
install("pkg", {brew: "pkg-brew"})
  → { op: "install", manager: "brew", pkg: "pkg-brew" }

linkFile({ source: source("f"), target: userConfig("f") })
  → { op: "link", src: "/abs/path/f", dst: "/home/user/.config/f" }

runCommand("cmd", {sudo: true})
  → { op: "runCommand", command: "cmd", sudo: true }

http("url", {integrity: "sha256-..."})
  → { op: "download", url, dest: "~/.cache/dotfiles/http/{hash}" }
  → { op: "link", src: cached_file, dst: target }
```

### Conditional Execution

Modules can declare when gates (AND'd together):

```typescript
when: [
  { platformIn: ["linux", "darwin"] },           // Declarative
  async (ctx) => await ctx.hasCmd("brew")        // Functional
]
```

**Context object** provides runtime environment (`dhd/src/ctx.ts`):
- `platform`, `arch`, `env`, `home`
- `hasCmd(cmd)` - check if command exists
- `fileExists(path)`, `readJson(path)` - filesystem queries

### Module Discovery

Auto-discovery mechanism (`dhd/src/cli.ts`):
1. Glob for `**/mod.{ts,js}` (ignoring node_modules, dist, .git)
2. Dynamic import each file via Bun
3. Extract default export
4. Store file path as `module._modulePath` (critical for path resolution!)

### Dependency Resolution

Uses depth-first traversal with deduplication (`dhd/src/orchestrator.ts`):
```typescript
async function visit(module) {
  if (seen.has(module.name)) return
  seen.add(module.name)
  for (const dep of module.dependsOn) {
    await visit(findModule(dep))
  }
  if (await evalWhen(module.when)) queue.push(module)
}
```

## Framework Layer Organization

The dhd framework is organized into focused layers:

- **`api.ts`** - User-facing builders (`install()`, `linkFile()`, `runCommand()`, `defineModule()`)
- **`schema.ts`** - Zod schemas for runtime validation and TypeScript types
- **`paths.ts`** - Path helpers and safety validation
- **`ctx.ts`** - Runtime context for when gates
- **`plan.ts`** - Action → PlanOp conversion
- **`exec.ts`** - PlanOp execution (spawn processes, create symlinks)
- **`orchestrator.ts`** - Workflow coordination (discovery → planning → execution)
- **`cli.ts`** - Entry point, argument parsing
- **`helpers.ts`** - High-level helpers (e.g., `user()` for shell configuration)

## Creating Modules

Modules live in `rawkOS/modules/<name>/mod.ts` with config files co-located.

### Pattern 1: Simple Package + Config
```typescript
export default defineModule({
  name: "starship",
  tags: ["terminal"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("starship"),
  linkFile({
    source: source("starship.toml"),    // Relative to mod.ts
    target: userConfig("starship.toml"), // ~/.config/starship.toml
    force: true,
  }),
])
```

### Pattern 2: Using Framework Helpers
```typescript
import { user } from "@rawkode/dhd"

// Helper handles OS-specific logic (dscl on macOS, chsh on Linux)
export default user({ shell: "fish" })
```

### Pattern 3: Platform-Specific Actions
Generate actions conditionally based on `process.platform`:
```typescript
const actions = []
if (process.platform === "darwin") {
  actions.push(runCommand("...", { sudo: true }))
}
return defineModule({...}).actions(actions)
```

## Important Conventions

### Module Files Must Be Named `mod.ts`
The glob pattern `**/mod.{ts,js}` is hardcoded. Don't use `*.module.ts` or `index.ts`.

### Source Paths Are Relative
Always use `source("file.conf")` not `source("./file.conf")` or absolute paths.

### Sudo Operations
Use the `sudo` flag on `runCommand()`, not inline `sudo` in the command string:
```typescript
// ✅ Correct
runCommand("echo foo | tee -a /etc/shells", { sudo: true })

// ❌ Wrong (bypasses upfront validation)
runCommand("sudo echo foo | sudo tee -a /etc/shells")
```

The framework validates sudo access once before execution starts.

### Path Helpers Usage
- `source()` - Files in the module directory
- `userPath()` - Files in home directory (`~/`)
- `userConfig()` - Files in `~/.config/`
- `systemPath()` - Absolute system paths
- `http()` - Remote files (cached in `~/.cache/dotfiles/http/`)

### Module Dependencies
Use `dependsOn: ["module-name"]` to ensure execution order. The framework performs topological sort.

### Adding New Action Types

When adding a new action type to the framework:

1. Add Zod schema to `schema.ts`:
   ```typescript
   export const NewAction = z.object({
     type: z.literal("newAction"),
     // ... fields
   }).strict()
   ```

2. Add type to `ActionT` union in `schema.ts`

3. Create builder in `api.ts`:
   ```typescript
   export function newAction(...) {
     return NewAction.parse({ type: "newAction", ... })
   }
   ```

4. Add `PlanOp` variant in `plan.ts` and conversion logic

5. Add execution handler in `exec.ts`:
   ```typescript
   if (op.op === "newAction") {
     // execute
     return
   }
   ```

6. Export from `index.ts`

### Adding New Helpers

High-level helpers go in `dhd/src/helpers.ts` and should:
- Accept options object for extensibility
- Handle OS-specific logic internally
- Return a module definition via `defineModule().actions()`
- Be exported from `dhd/src/index.ts`

## Common Gotchas

### Module Path Resolution
The `_modulePath` property is set during discovery and used during planning. If you manually construct modules (e.g., in helpers), path resolution works because `source()` paths are resolved later during planning when the module directory is known.

### Workspace Dependencies
rawkOS depends on dhd via `workspace:*` protocol. When making framework changes, no rebuild is needed - Bun resolves directly to source.

### Package Manager Detection
The framework auto-detects package managers via `Bun.which()` in order:
`brew` → `pacman` → `apt` → `dnf` → `yay` → `nix`

First found is used for all install operations.

### HTTP Source Caching
HTTP sources are downloaded to `~/.cache/dotfiles/http/{sha256-hash-of-url}` and reused across runs. Integrity checking is optional but recommended for security.
