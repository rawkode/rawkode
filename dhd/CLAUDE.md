# Claude Development Guidelines for DHD

This file contains important information for Claude when working on the DHD (Declarative Host Deployment) project.

## Project Overview

DHD is a TypeScript-based declarative configuration management system that uses a DAG (Directed Acyclic Graph) for dependency resolution and execution. It's designed to automate system setup and maintenance through modular configuration files.

## Key Technical Details

### Build System
- **Package Manager**: Bun (not npm)
- **Scripts**: 
  - `bun test` - Run tests
  - `bun run publish` - Publish the package
  - No "dev" script exists

### Project Structure
- `/core/` - Core execution engine, DAG management, and system context
- `/core/actions/` - Action implementations (command, file, package, http, conditional)
- `/core/ink/` - Terminal UI components using Ink
- `/utils/` - Helper utilities for various system operations
- `/cli.ts` - Main CLI entry point

### Action Types
1. **command** - Execute shell commands
2. **file** - File operations (create, symlink, template)
3. **package** - System package management
4. **http** - HTTP requests
5. **conditional** - Conditional execution based on system state

### Important Patterns
- Modules are defined using `defineModule()` from `core/module-builder.ts`
- Actions support dependencies via the `dependsOn` property
- The DAG ensures proper execution order and parallelization
- System context provides platform information and utilities

### Testing & Quality
- Always run `bun test` before suggesting changes are complete
- The project uses TypeScript for type safety
- Consider telemetry implications when adding new features

### Common Tasks
- Adding new action types: Create in `/core/actions/`, update `/core/actions/index.ts`
- Module creation: Use the `defineModule()` helper for consistent structure
- Visualization: The `--visualize` flag enables the Ink-based TUI

## Notes
- The project is part of a larger rawkOS ecosystem
- Focus on declarative, idempotent operations
- Maintain compatibility with the existing DAG execution model