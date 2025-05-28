# rawkOS - System Configuration Management Framework

## Project Overview

rawkOS is a comprehensive Linux system configuration management framework written in TypeScript/Bun. It automates the setup and maintenance of a complete Linux desktop environment, including system configuration, dotfiles management, application installation, and desktop environment customization.

### Key Features

- **Modular Architecture**: Each component (git, firefox, fonts, etc.) is a self-contained module
- **Declarative Configuration**: Uses a builder pattern to define system state
- **Smart Dependency Resolution**: Modules can depend on each other, executed in correct order via DAG
- **Conditional Execution**: Actions run only when needed based on system state
- **Hardware Detection**: Automatically detects and configures based on hardware (fingerprint, GPU, etc.)
- **Desktop Environment Support**: Supports GNOME, KDE, and Niri with environment-specific configurations
- **Multiple Package Managers**: Supports pacman/paru, flatpak, brew, cargo, and go install

## Architecture

### Core Components

1. **Module System** (`core/module.ts`, `core/module-builder.ts`)
   - Each module defines metadata (name, description, dependencies, tags)
   - Actions are executed in sequence within a module
   - Modules are executed in dependency order across the system

2. **Action System** (`core/action.ts`, `core/actions/`)
   - Actions are atomic operations (install package, create symlink, run command, etc.)
   - Each action has a `plan()` method (dry-run) and `apply()` method (execute)
   - Supports conditional actions based on system context

3. **System Context** (`core/system-context.ts`)
   - Detects hardware: fingerprint readers, TPM, GPU (NVIDIA/AMD/Intel)
   - Detects desktop environment: GNOME, KDE, Niri, Wayland/X11
   - Provides user information and system platform details

4. **DAG Executor** (`core/dag.ts`, `core/executor.ts`)
   - Builds a directed acyclic graph of module dependencies
   - Executes modules in parallel when possible
   - Ensures correct execution order

### Available Actions

1. **Package Installation** (`packageInstall`)
   - Managers: pacman/arch, flatpak, brew, go, cargo
   - Automatically checks if packages are already installed
   - Handles elevation when needed

2. **File Operations**
   - `symlink`: Create symbolic links (with home directory expansion)
   - `fileWrite`: Write content to files
   - `fileCopy`: Copy files (supports privileged operations)

3. **Command Execution** (`command`)
   - Run arbitrary commands with arguments
   - Supports elevation and environment variables

4. **Conditional Actions** (`when`)
   - Execute actions only when conditions are met
   - Built-in conditions: `isGnome`, `hasFingerprint`, `isWayland`, etc.

5. **Custom Actions**
   - Extend the Action class for complex operations
   - Examples: DconfImportAction, InstallExtensionsAction

## Module Categories

### Command-Line Tools (`command-line/`)
- **Shell & Terminal**: fish, nushell, zellij, starship
- **Development Tools**: git, github, docker/podman, direnv
- **Productivity**: atuin (shell history), espanso (text expansion), runme
- **File Management**: eza, bat, ripgrep, zoxide
- **Cloud & DevOps**: kubernetes, google-cloud, tailscale

### Desktop Applications (`desktop/`)
- **Browsers**: firefox (developer edition)
- **Terminals**: ghostty, wezterm
- **Editors**: visual-studio-code, zed
- **Communication**: slack, zulip
- **Development**: gitbutler
- **Security**: onepassword (with SSH agent)
- **Media**: spotify
- **Window Managers**: gnome, kde, niri (with waybar, swaync)

### Development Environments (`development/`)
- **Languages**: go, rust, python, deno
- **Configuration**: Environment variables, PATH setup

### System Configuration (`system/`)
- **Hardware**: AMD GPU configuration, fingerprint reader
- **Security**: DNS configuration, fonts
- **Boot**: Secure boot helpers

### Themes (`themes/`)
- **Catppuccin**: System-wide theme configuration

## CLI Usage

### Main Executable: `rks`

```bash
# Show what changes would be made (dry-run)
rks plan

# Apply all configurations
rks apply

# Target specific modules
rks plan command-line/git desktop/firefox
rks apply nushell

# List all available modules
rks list

# Verbose output
rks apply -v
```

### Legacy CLI: `cli.ts`

```bash
# Bootstrap system (1password first)
bun cli.ts --bootstrap

# Configure system-level settings
bun cli.ts --system

# Install and configure user dotfiles
bun cli.ts --dotfiles
```

## Development Guide

### Creating a New Module

1. Create a directory under appropriate category
2. Create `mod.ts` file:

```typescript
import { defineModule } from "../../core/module-builder.ts";
import { conditions } from "../../core/conditions.ts";

export default defineModule("module-name")
  .description("Module description")
  .tags("tag1", "tag2")
  .dependsOn("other-module")  // Optional
  .packageInstall({
    manager: "pacman",
    packages: ["package-name"],
  })
  .symlink({
    source: "config-file",  // Relative to module directory
    target: ".config/app/config",  // Relative to home directory
  })
  .when(conditions.isGnome)
    .command({
      command: "gsettings",
      args: ["set", "org.gnome.desktop.interface", "gtk-theme", "Catppuccin"],
    })
  .build();
```

### Custom Actions

For complex operations, create custom actions:

```typescript
class MyCustomAction extends Action {
  async plan(context: ActionContext): Promise<SideEffect[]> {
    return [{
      type: "command_run",
      description: "Do something special",
      requiresElevation: false,
    }];
  }

  async apply(context: ActionContext): Promise<void> {
    if (context.dryRun) return;
    // Implementation
  }
}
```

### Testing Modules

1. Use `rks plan module-name` to see what would happen
2. Use `rks apply module-name -v` for verbose execution
3. Check effects without making changes using dry-run mode

## Important Files

- `build.ts`: Build script for creating the `rks` executable
- `cli.ts`: Legacy CLI for bootstrap/system/dotfiles operations
- `core/`: Core framework implementation
- `utils/`: Utility functions for common operations
- `biome.json`: Code formatting and linting configuration

## Conventions

1. **Module Naming**: Use kebab-case, match directory name
2. **File Paths**:
   - Source paths are relative to module directory
   - Target paths starting with `.` are relative to home directory
   - Absolute paths are used as-is
3. **Dependencies**: Only declare direct dependencies
4. **Elevation**: Framework handles sudo/elevation automatically
5. **Idempotency**: Modules should be safe to run multiple times

## Linting and Formatting

```bash
# Format code
bunx biome format --write

# Run linter
bunx biome lint --write

# Or use the README command
bun run format-lint
```

## Security Considerations

- The framework requires elevated privileges for system modifications
- Sensitive files (SSH keys, etc.) should use appropriate permissions
- 1password integration provides secure secret management
- Fingerprint authentication is automatically configured when hardware is detected

## Current State

The project has uncommitted changes in:
- `core/actions/command.ts`: Command execution implementation
- `core/actions/file.ts`: File operation implementations
- `desktop/gnome/mod.ts`: GNOME configuration
- `system/fprintd/mod.ts`: Fingerprint authentication setup

These appear to be work-in-progress improvements to the action system and desktop environment configurations.
