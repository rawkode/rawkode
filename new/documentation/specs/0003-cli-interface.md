# SPEC-0003: CLI Interface

## Overview
This specification defines the command-line interface for the dotfile manager.

## Command Structure

```
dot <command> [options] [arguments]
```

## Global Options

| Option | Short | Description |
|--------|-------|-------------|
| `--repo <path>` | `-r` | Path to dotfiles repository (default: `~/.dotfiles`) |
| `--verbose` | `-v` | Enable verbose output |
| `--dry-run` | `-n` | Show what would be done without making changes |
| `--help` | `-h` | Show help information |
| `--version` | | Show version information |

## Commands

### `dot init`

Initialize a new dotfiles repository.

```
dot init [path]
```

**Arguments:**
- `path` - Directory to initialize (default: `~/.dotfiles`)

**Options:**
- `--bare` - Initialize without example configuration

**Behavior:**
1. Create directory if it doesn't exist
2. Initialize git repository
3. Create directory structure (`files/`, `templates/`, `.dotfiles/`)
4. Create starter `Dotfile.swift`
5. Create `Package.swift` for DSL compilation

**Example:**
```bash
$ dot init
Initialized dotfiles repository at ~/.dotfiles
Created:
  - Dotfile.swift (configuration)
  - files/ (your dotfiles go here)
  - templates/ (templated files go here)

Next steps:
  1. Add files to manage: dot add ~/.zshrc
  2. Edit Dotfile.swift to configure mappings
  3. Run 'dot sync' to create symlinks
```

### `dot sync`

Synchronize dotfiles to their target locations.

```
dot sync [group...]
```

**Arguments:**
- `group` - Optional group names to sync (default: all)

**Options:**
- `--force` - Overwrite targets without backing up
- `--no-pull` - Skip git pull before syncing

**Behavior:**
1. Pull latest changes from remote (unless `--no-pull`)
2. Compile and load `Dotfile.swift`
3. For each entry:
   - If template: render to `.dotfiles/rendered/`
   - Check target location
   - Backup existing file if needed
   - Create symlink
4. Update state tracking
5. Report results

**Example:**
```bash
$ dot sync
Pulling latest changes... done
Compiling configuration... done

Syncing 12 files:
  ✓ ~/.zshrc → files/zshrc
  ✓ ~/.gitconfig → templates/gitconfig (rendered)
  ⚠ ~/.config/nvim → backed up existing to ~/.config/nvim.backup.20240115
  ✓ ~/.config/nvim → files/config/nvim
  ...

Sync complete: 12 synced, 1 backed up, 0 failed
```

### `dot status`

Show status of managed dotfiles.

```
dot status [--all]
```

**Options:**
- `--all` - Include up-to-date files (default: only show issues)

**Output:**
```bash
$ dot status
Dotfiles status (3 issues):

  Missing symlinks:
    ✗ ~/.zshrc (target doesn't exist)

  Broken symlinks:
    ✗ ~/.config/nvim (points to non-existent source)

  Modified targets:
    ! ~/.tmux.conf (target is regular file, not symlink)

Run 'dot sync' to fix issues.
```

### `dot add`

Add an existing file to be managed.

```
dot add <file> [--as <name>]
```

**Arguments:**
- `file` - Path to file to add (e.g., `~/.zshrc`)

**Options:**
- `--as <name>` - Name in repository (default: derived from path)
- `--template` - Add as template instead of plain file

**Behavior:**
1. Copy file to repository (`files/` or `templates/`)
2. Replace original with symlink
3. Add entry to `Dotfile.swift`
4. Stage changes in git

**Example:**
```bash
$ dot add ~/.zshrc
Added ~/.zshrc as files/zshrc
Updated Dotfile.swift
Created symlink: ~/.zshrc → ~/.dotfiles/files/zshrc

Changes staged. Run 'git commit' to save.
```

### `dot remove`

Stop managing a file.

```
dot remove <file> [--keep]
```

**Arguments:**
- `file` - Managed file to remove

**Options:**
- `--keep` - Keep the symlink (don't restore original)
- `--delete` - Delete from repository (default: keep in repo)

**Behavior:**
1. Remove entry from `Dotfile.swift`
2. Remove symlink at target
3. Optionally restore from backup or copy from repo
4. Stage changes in git

**Example:**
```bash
$ dot remove ~/.zshrc
Removed ~/.zshrc from management
Restored original file from backup
Updated Dotfile.swift

Changes staged. Run 'git commit' to save.
```

### `dot list`

List all managed files.

```
dot list [--group <name>] [--templates]
```

**Options:**
- `--group <name>` - Filter by group
- `--templates` - Show only templates
- `--json` - Output as JSON

**Example:**
```bash
$ dot list
Managed files (12):

Shell:
  files/zshrc → ~/.zshrc
  files/zsh/ → ~/.zsh/

Git:
  templates/gitconfig → ~/.gitconfig
  files/gitignore_global → ~/.gitignore_global

Editor:
  files/config/nvim/ → ~/.config/nvim/
```

### `dot edit`

Open configuration for editing.

```
dot edit [file]
```

**Arguments:**
- `file` - Specific file to edit (default: `Dotfile.swift`)

**Behavior:**
Opens file in `$EDITOR` or `$VISUAL`.

### `dot diff`

Show differences between repo and deployed files.

```
dot diff [file]
```

**Arguments:**
- `file` - Specific file to diff (default: all)

**Behavior:**
For templates, shows diff between rendered output and what would be rendered now.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error |
| 3 | File operation error |
| 4 | Git operation error |

## Output Formatting

- Use colors when stdout is a TTY
- Respect `NO_COLOR` environment variable
- Use symbols for status: `✓` success, `✗` failure, `!` warning, `→` arrow

## Shell Completion

Provide completion scripts for:
- Bash
- Zsh
- Fish

Generated via: `dot completions <shell>`
