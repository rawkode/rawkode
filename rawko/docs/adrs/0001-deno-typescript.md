# ADR-0001: Deno + TypeScript

## Status

Accepted (2026-01-23)

## Context

rawko-sdk is a complete rewrite of the original Rust-based rawko tool. We need to select a runtime environment and programming language that supports:

- Integration with Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Integration with GitHub Copilot SDK (`@github/copilot-sdk`)
- Rapid iteration and development
- Strong typing for complex state machine logic
- Modern async/await patterns for streaming responses

The original rawko was written in Rust, which provided excellent performance but required custom FFI bindings or protocol implementations to work with JavaScript-based SDKs. As both Claude and Copilot provide first-class JavaScript/TypeScript SDKs, a JavaScript runtime makes SDK integration straightforward.

## Decision

Use **Deno** as the runtime with **TypeScript** as the primary language for rawko-sdk.

### Key Capabilities

1. **Native TypeScript support** - No build step required; Deno executes TypeScript directly
2. **Built-in security model** - Explicit permissions for network, file system, and environment access
3. **Modern ESM-first approach** - Native ES modules without CommonJS complexity
4. **First-class testing and formatting** - `deno test`, `deno fmt`, `deno lint` built-in
5. **npm compatibility** - Access to npm packages via `npm:` specifiers

### SDK Integration

```typescript
// Direct npm imports in Deno
import { ClaudeAgent } from "npm:@anthropic-ai/claude-agent-sdk";
import { CopilotSession } from "npm:@github/copilot-sdk";
```

## Consequences

### Positive

- **No build toolchain** - Eliminates webpack/esbuild/rollup configuration complexity
- **Type safety** - Full TypeScript support catches errors at development time
- **Security by default** - Permissions must be explicitly granted (`--allow-read`, `--allow-net`)
- **Modern standards** - Top-level await, ES modules, Web APIs (fetch, WebSocket)
- **SDK compatibility** - Both Claude and Copilot SDKs work via npm: specifiers
- **Single binary** - Deno can compile to standalone executables via `deno compile`
- **Testing built-in** - No need for Jest/Vitest configuration

### Negative

- **Smaller ecosystem** - Fewer Deno-native libraries compared to Node.js
- **Learning curve** - Teams familiar with Node.js need to learn Deno idioms
- **npm compatibility gaps** - Some npm packages with native dependencies may not work
- **Less mature** - Deno is younger than Node.js with potentially more breaking changes

## Alternatives Considered

### Node.js + TypeScript

**Pros**: Larger ecosystem, more mature, familiar to most developers
**Cons**: Requires build step (tsc or bundler), no built-in security model, CommonJS/ESM complexity

**Rejected because**: Build toolchain complexity adds friction; Deno's security model aligns with rawko's need to control tool permissions.

### Rust (Continue Original)

**Pros**: Maximum performance, existing codebase, memory safety
**Cons**: No native SDK support, requires FFI or protocol reimplementation, slower iteration

**Rejected because**: Both target SDKs are JavaScript-native; Rust would require significant bridging effort.

### Bun

**Pros**: Fast, Node.js compatible, built-in TypeScript
**Cons**: Less mature than Deno, weaker security model, fewer built-in tools

**Rejected because**: Deno's permission model better matches rawko's security requirements.

## Implementation Notes

### Project Structure

```
rawko-sdk/
├── deno.json           # Deno configuration
├── deno.lock           # Lock file
├── mod.ts              # Main entry point
├── src/
│   ├── providers/      # Provider implementations
│   ├── machine/        # XState machine
│   └── config/         # Configuration loading
└── .rawko/             # Default config and agents
```

### deno.json Configuration

```json
{
  "name": "@rawkode/rawko-sdk",
  "version": "0.1.0",
  "exports": "./mod.ts",
  "tasks": {
    "dev": "deno run --watch mod.ts",
    "test": "deno test --allow-read",
    "lint": "deno lint",
    "fmt": "deno fmt"
  },
  "imports": {
    "@anthropic-ai/claude-agent-sdk": "npm:@anthropic-ai/claude-agent-sdk@^0.1.0",
    "@github/copilot-sdk": "npm:@github/copilot-sdk@^0.1.0",
    "xstate": "npm:xstate@^5.0.0"
  }
}
```

### Permission Model

rawko-sdk requires the following Deno permissions:

| Permission | Purpose |
|------------|---------|
| `--allow-read` | Read project files and configs |
| `--allow-write` | Write/edit files (developer/tester modes) |
| `--allow-net` | Connect to Claude/Copilot APIs |
| `--allow-env` | Read API keys from environment |
| `--allow-run` | Execute Bash commands via tools |

These can be scoped to specific paths/hosts:

```bash
deno run \
  --allow-read=. \
  --allow-write=. \
  --allow-net=api.anthropic.com,api.github.com \
  --allow-env=ANTHROPIC_API_KEY,GITHUB_TOKEN \
  --allow-run=bash,git,npm \
  mod.ts
```
