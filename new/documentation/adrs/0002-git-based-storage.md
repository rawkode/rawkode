# ADR-0002: Git-Based Storage

## Status
Accepted

## Context
Dotfiles need to be stored, versioned, and synchronized across multiple machines. Options considered:
- Git repository
- Cloud storage (iCloud, Dropbox)
- Custom sync server
- Local-only management

## Decision
We will use a Git repository as the source of truth for dotfile storage and synchronization.

## Rationale
- **Industry standard**: Git is ubiquitous and well-understood
- **Version control**: Full history of changes with ability to rollback
- **Branching**: Experiment with configurations without affecting stable setup
- **Hosting flexibility**: Use GitHub, GitLab, self-hosted, or any Git remote
- **Offline capable**: Full repository available locally
- **Diff and merge**: Built-in tools for understanding and resolving changes

## Consequences
### Positive
- Users leverage existing Git knowledge
- No vendor lock-in for hosting
- Robust conflict resolution via Git tooling
- Easy sharing and collaboration via standard Git workflows

### Negative
- Requires Git to be installed on target machines
- Large binary files (fonts, etc.) may bloat repository
- Learning curve for users unfamiliar with Git

## Implementation Notes
- The tool will shell out to `git` rather than embedding libgit2
- Repository location is user-configurable (default: `~/.dotfiles`)
- Tool provides convenience commands that wrap common git operations
