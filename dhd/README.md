# DHD - Declarative Host Deployment

A TypeScript-based declarative configuration management system for automating system setup and maintenance.

## Overview

DHD provides a modular, declarative approach to system configuration using a DAG (Directed Acyclic Graph) based execution model. It supports various action types including file management, package installation, command execution, and HTTP requests.

## Features

- **Declarative Configuration**: Define your system state using TypeScript modules
- **DAG-based Execution**: Automatic dependency resolution and parallel execution
- **Multiple Action Types**:
  - File operations (create, symlink, template)
  - Package management (system packages)
  - Command execution
  - HTTP requests
  - Conditional execution
- **Interactive Visualization**: Built-in Ink-based TUI for monitoring execution
- **Telemetry**: OpenTelemetry integration for observability

## Installation

```bash
bun install
```

## Usage

```bash
# Run with a specific module
bun run cli.ts path/to/module.ts

# Run with visualization
bun run cli.ts --visualize path/to/module.ts
```

## Module Structure

Modules are TypeScript files that export a configuration object:

```typescript
import { defineModule } from './core/module-builder';

export default defineModule({
  name: 'example-module',
  actions: [
    {
      type: 'package',
      name: 'install-git',
      packages: ['git']
    },
    {
      type: 'file',
      name: 'create-config',
      path: '~/.gitconfig',
      content: '[user]\n  name = Your Name'
    }
  ]
});
```

## Architecture

- **Core**: The execution engine, DAG management, and action definitions
- **Actions**: Different action types (command, file, package, http, conditional)
- **Ink**: Interactive terminal UI components
- **Utils**: Helper utilities for system operations

## Development

```bash
# Run tests
bun test

# Publish package
bun run publish
```