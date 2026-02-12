# General Coding Rules

- Everything is a state machine.
- Prefer popular packages, such as xstate, over building our own.
- We ONLY tests behaviours, avoid useless tests.
- Files should never be more than 500 lines.
  - Exceptions can be made if tests live in the same file as the code.
- Group by domain, not type.
  - Example: ./src/users ./src/groups
  - Never: ./src/controllers ./src/types

# JavaScript / TypeScript

- Unless a bun.lock exists, always use Deno

# Rust

- Never use println!, always use tracing
- If something can be a Trait, use a Trait
  - Always plan for extensibility
