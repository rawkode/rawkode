# Dotfile Manager Documentation

A Swift-based dotfile manager for synchronizing configurations across machines.

## Overview

| Aspect | Decision |
|--------|----------|
| Language | Swift |
| Storage | Git repository |
| Deployment | Symlinks |
| Configuration | Swift DSL |
| Templating | Swift-native string interpolation |
| Platforms | macOS, Linux, Windows (WSL) |

## Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [0001](adrs/0001-swift-implementation.md) | Swift as Implementation Language | Accepted |
| [0002](adrs/0002-git-based-storage.md) | Git-Based Storage | Accepted |
| [0003](adrs/0003-symlink-deployment.md) | Symlink Deployment Strategy | Accepted |
| [0004](adrs/0004-swift-dsl-configuration.md) | Swift DSL for Configuration | Accepted |
| [0005](adrs/0005-swift-native-templating.md) | Swift-Native Templating | Accepted |
| [0006](adrs/0006-cross-platform-support.md) | Cross-Platform Support | Accepted |

## Specifications

| Spec | Title | Description |
|------|-------|-------------|
| [0001](specs/0001-core-architecture.md) | Core Architecture | Component design and data flow |
| [0002](specs/0002-configuration-dsl.md) | Configuration DSL | Swift DSL syntax and types |
| [0003](specs/0003-cli-interface.md) | CLI Interface | Commands and options |
| [0004](specs/0004-templating-system.md) | Templating System | Template structure and context |
| [0005](specs/0005-file-management.md) | File Management | Symlinks, backups, and state |

## Key Design Decisions

### Simplicity First
- No secrets management (handle manually or via separate tools)
- No lifecycle hooks
- Symlinks only (no copy mode)

### Type Safety
- Swift DSL catches configuration errors at compile time
- Templates are valid Swift code with IDE support
- Explicit file mappings (no magic conventions)

### User Experience
- Git-style subcommands (`dot sync`, `dot status`)
- Auto-backup of existing files
- Dry-run mode for all operations
- Clear status output

## Quick Reference

```bash
# Initialize
dot init ~/.dotfiles

# Add a file
dot add ~/.zshrc

# Check status
dot status

# Sync all files
dot sync

# Sync specific group
dot sync Shell

# List managed files
dot list
```

## Example Configuration

```swift
import DotfileKit

@main
struct MyDotfiles: DotfileConfiguration {
    var body: some DotfileContent {
        Group("Shell") {
            File("zshrc").target("~/.zshrc")
        }

        Group("Git") {
            Template("gitconfig").target("~/.gitconfig")
        }

        if Machine.os == .macos {
            File("Brewfile").target("~/.Brewfile")
        }
    }
}
```
