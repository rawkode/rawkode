# SPEC-0005: File Management

## Overview
This specification defines how files are managed, including symlink creation, backup handling, and state tracking.

## Symlink Strategy

### Creating Symlinks

For each managed file:

```
Source: ~/.dotfiles/files/zshrc
Target: ~/.zshrc
Result: ~/.zshrc -> ~/.dotfiles/files/zshrc
```

### Symlink Validation

A symlink is considered valid when:
1. Target path is a symbolic link
2. Link points to the expected source in the dotfiles repo
3. Source file/directory exists

```swift
func isValidSymlink(target: Path, expectedSource: Path) -> Bool {
    guard FileManager.default.isSymbolicLink(atPath: target.string) else {
        return false
    }

    let actualSource = try? FileManager.default.destinationOfSymbolicLink(atPath: target.string)
    return actualSource == expectedSource.string
}
```

## Backup System

### When Backups Occur

Backups are created when:
1. Target exists and is a regular file (not a symlink)
2. Target exists and is a symlink to a different location
3. Target exists and is a directory (not symlink to directory)

### Backup Naming

```
<original-path>.backup.<ISO8601-timestamp>
```

Examples:
```
~/.zshrc.backup.2024-01-15T143022
~/.config/nvim.backup.2024-01-15T143022
```

### Backup Location

Backups are stored adjacent to the original file location by default:

```
Original: ~/.zshrc
Backup:   ~/.zshrc.backup.2024-01-15T143022
```

### Backup Index

A backup index is maintained in `.dotfiles/backups.json`:

```json
{
  "backups": [
    {
      "original": "~/.zshrc",
      "backup": "~/.zshrc.backup.2024-01-15T143022",
      "created": "2024-01-15T14:30:22Z",
      "reason": "sync",
      "checksum": "sha256:abc123..."
    }
  ]
}
```

### Backup Operations

```swift
public struct BackupManager {
    /// Create a backup of the given path
    func backup(path: Path) throws -> BackupRecord

    /// List all backups for a path
    func backups(for path: Path) -> [BackupRecord]

    /// Restore from a specific backup
    func restore(backup: BackupRecord) throws

    /// Delete old backups (keep last N)
    func prune(keeping: Int) throws -> [BackupRecord]
}
```

## State Tracking

### State File

State is tracked in `.dotfiles/state.json`:

```json
{
  "version": 1,
  "lastSync": "2024-01-15T14:30:22Z",
  "entries": {
    "~/.zshrc": {
      "source": "files/zshrc",
      "type": "file",
      "synced": "2024-01-15T14:30:22Z",
      "sourceChecksum": "sha256:abc123..."
    },
    "~/.gitconfig": {
      "source": "templates/gitconfig.swift",
      "type": "template",
      "synced": "2024-01-15T14:30:22Z",
      "sourceChecksum": "sha256:def456...",
      "renderedChecksum": "sha256:ghi789..."
    }
  }
}
```

### State Operations

```swift
public struct StateManager {
    /// Load state from disk
    func load() throws -> DotfileState

    /// Save state to disk
    func save(_ state: DotfileState) throws

    /// Update entry after sync
    func update(entry: String, source: String, checksum: String) throws

    /// Get entries that need sync
    func staleEntries() throws -> [StateEntry]
}
```

## Conflict Detection

### Conflict Types

```swift
public enum Conflict {
    /// Target exists and is not a symlink
    case existingFile(path: Path)

    /// Target is symlink to different location
    case wrongSymlink(path: Path, pointsTo: Path)

    /// Target is directory, source is file
    case typeMismatch(path: Path, expected: FileType, actual: FileType)

    /// Parent directory doesn't exist
    case missingParent(path: Path)

    /// No write permission
    case permissionDenied(path: Path)
}
```

### Conflict Resolution

| Conflict | Default Action | With `--force` |
|----------|---------------|----------------|
| Existing file | Backup, then link | Backup, then link |
| Wrong symlink | Backup, then relink | Remove, then link |
| Type mismatch | Error, skip | Backup, then link |
| Missing parent | Create parents | Create parents |
| Permission denied | Error, skip | Error, skip |

## Directory Handling

### Directory Symlinks

Entire directories can be symlinked:

```swift
File("config/nvim")
    .target("~/.config/nvim")
```

This creates:
```
~/.config/nvim -> ~/.dotfiles/files/config/nvim
```

### Parent Directory Creation

If target parent doesn't exist, it's created:

```swift
// If ~/.config doesn't exist
File("config/nvim").target("~/.config/nvim")
// Creates ~/.config/ then symlinks nvim
```

Permissions for created directories: `0755`

## File Permissions

### Preserving Permissions

Source file permissions are preserved through symlinks (symlinks don't have their own permissions).

### Executable Files

Files that should be executable (scripts) maintain their execute bit in the repository.

### Sensitive Files

For files that should be private (e.g., SSH config):

```swift
File("ssh/config")
    .target("~/.ssh/config")
    .permissions(0o600)  // Validated after sync
```

## Operations

### Sync Operation

```swift
func sync(entry: DotfileEntry) throws -> SyncResult {
    let source = resolveSource(entry)
    let target = expandTarget(entry.target)

    // Handle templates
    if entry.isTemplate {
        source = renderTemplate(entry)
    }

    // Check for conflicts
    if let conflict = detectConflict(target: target, source: source) {
        try resolveConflict(conflict)
    }

    // Create parent directories if needed
    try createParentDirectories(for: target)

    // Create symlink
    try FileManager.default.createSymbolicLink(
        atPath: target.string,
        withDestinationPath: source.string
    )

    // Update state
    try state.update(entry: target, source: source)

    return .success(target: target, source: source)
}
```

### Add Operation

```swift
func add(file: Path, as name: String?) throws -> AddResult {
    let source = repositoryPath(for: file, name: name)

    // Copy file to repository
    try FileManager.default.copyItem(at: file, to: source)

    // Replace original with symlink
    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(
        atPath: file.string,
        withDestinationPath: source.string
    )

    // Update configuration
    try configuration.addEntry(source: source, target: file)

    // Stage in git
    try git.add(files: [source, "Dotfile.swift"])

    return .success(source: source, target: file)
}
```

### Remove Operation

```swift
func remove(file: Path, restore: Bool) throws -> RemoveResult {
    let entry = try configuration.entry(for: file)

    // Remove symlink
    try FileManager.default.removeItem(at: file)

    // Restore original if requested and backup exists
    if restore, let backup = backups.latest(for: file) {
        try FileManager.default.copyItem(at: backup.path, to: file)
    }

    // Update configuration
    try configuration.removeEntry(target: file)

    // Update state
    try state.remove(entry: file)

    return .success(file: file, restored: restore)
}
```

## Error Handling

```swift
public enum FileOperationError: Error {
    case sourceNotFound(Path)
    case targetExists(Path)
    case symlinkFailed(source: Path, target: Path, underlying: Error)
    case backupFailed(Path, underlying: Error)
    case permissionDenied(Path)
    case invalidPath(String)
}
```

All file operations are atomic where possible and include proper error recovery (e.g., restoring backups on failure).
