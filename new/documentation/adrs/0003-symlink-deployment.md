# ADR-0003: Symlink Deployment Strategy

## Status
Accepted

## Context
Managed dotfiles need to be deployed from the repository to their target locations (typically under `$HOME`). Options considered:
- Symbolic links
- Hard links
- File copying
- Hybrid approach

## Decision
We will use symbolic links exclusively for deploying dotfiles.

## Rationale
- **Live updates**: Changes to source files are immediately reflected at target
- **Single source of truth**: No synchronization needed between repo and deployed files
- **Transparency**: `ls -la` clearly shows where files originate
- **Atomic updates**: Replacing a symlink is atomic
- **Simplicity**: One mechanism to understand and debug

## Consequences
### Positive
- Edit files in-place, changes automatically tracked in git
- No drift between repository and deployed state
- Easy to identify managed files
- Rollback is simple: checkout previous version, symlinks point to new content

### Negative
- Some applications don't handle symlinks well (rare)
- Symlinks visible in directory listings (may be undesirable for some)
- Requires target filesystem to support symlinks (not an issue on modern systems)

## Conflict Handling
When a target path already exists and is not a symlink to our managed file:
1. Create a backup at `<target>.backup.<timestamp>`
2. Remove the existing file/directory
3. Create the symlink
4. Log the backup location for user reference
