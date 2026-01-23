# SPEC-0001: Core Architecture

## Overview
This specification defines the high-level architecture of the dotfile manager.

## Components

### 1. CLI Layer
**Responsibility**: Parse commands, handle user interaction, format output.

```
┌─────────────────────────────────────────────────────┐
│                    CLI (main.swift)                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │  init   │ │  sync   │ │ status  │ │  add/rm   │ │
│  └────┬────┘ └────┬────┘ └────┬────┘ └─────┬─────┘ │
└───────┼──────────┼──────────┼─────────────┼────────┘
        │          │          │             │
        ▼          ▼          ▼             ▼
┌─────────────────────────────────────────────────────┐
│                   Core Engine                        │
└─────────────────────────────────────────────────────┘
```

**Implementation**: Swift ArgumentParser

### 2. Core Engine
**Responsibility**: Orchestrate operations, manage state, coordinate subsystems.

```swift
public struct DotfileEngine {
    let config: Configuration
    let fileManager: FileManaging
    let templateEngine: TemplateEngine
    let gitClient: GitClient

    func sync() async throws -> SyncResult
    func status() async throws -> StatusReport
    func add(file: Path) async throws
    func remove(file: Path) async throws
}
```

### 3. Configuration Loader
**Responsibility**: Compile and execute the Swift DSL configuration.

```swift
public protocol ConfigurationLoader {
    func load(from path: Path) async throws -> Configuration
}
```

### 4. File Manager
**Responsibility**: Handle all filesystem operations (symlinks, backups, permissions).

```swift
public protocol FileManaging {
    func createSymlink(from source: Path, to target: Path) throws
    func backup(path: Path) throws -> Path
    func exists(at path: Path) -> Bool
    func isSymlink(at path: Path) -> Bool
    func readLink(at path: Path) throws -> Path
}
```

### 5. Template Engine
**Responsibility**: Process Swift templates and produce final file contents.

```swift
public protocol TemplateEngine {
    func render(template: Path, context: TemplateContext) throws -> String
}
```

### 6. Git Client
**Responsibility**: Interface with Git for repository operations.

```swift
public protocol GitClient {
    func status() async throws -> [FileStatus]
    func add(files: [Path]) async throws
    func commit(message: String) async throws
    func pull() async throws
    func push() async throws
}
```

## Directory Structure

```
~/.dotfiles/                    # Default repository location
├── Dotfile.swift               # Configuration DSL
├── Package.swift               # SPM manifest (generated)
├── files/                      # Direct files (symlinked as-is)
│   ├── zshrc
│   ├── tmux.conf
│   └── config/
│       └── nvim/
├── templates/                  # Template files
│   ├── gitconfig.swift
│   └── ssh_config.swift
└── .dotfiles/                  # Tool metadata
    ├── state.json              # Tracking state
    └── backups/                # Backup storage
```

## Data Flow

### Sync Operation
```
1. Load Configuration (Dotfile.swift)
         │
         ▼
2. Build Dependency Graph
         │
         ▼
3. For each managed file:
   ├── Is template? → Render with TemplateEngine
   │        │
   │        ▼
   │   Write to .dotfiles/rendered/
   │
   ├── Check target exists?
   │   ├── Yes, is our symlink? → Skip (up to date)
   │   ├── Yes, different file? → Backup, then link
   │   └── No → Create parent dirs, link
   │
   └── Create symlink
         │
         ▼
4. Update state.json
         │
         ▼
5. Report results
```

## Error Handling Strategy

All operations that can fail use Swift's structured error handling:

```swift
public enum DotfileError: Error {
    case configurationNotFound(Path)
    case configurationInvalid(String)
    case targetExists(Path, suggestion: String)
    case symlinkFailed(source: Path, target: Path, underlying: Error)
    case templateRenderFailed(template: Path, reason: String)
    case gitOperationFailed(operation: String, underlying: Error)
}
```

## Concurrency Model

- Use Swift's structured concurrency (`async`/`await`)
- File operations are inherently sequential per-file
- Multiple independent files can be processed concurrently
- Git operations are serialized
