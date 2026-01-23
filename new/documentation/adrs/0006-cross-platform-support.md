# ADR-0006: Cross-Platform Support

## Status
Accepted

## Context
The tool needs to run on multiple operating systems:
- macOS (primary development platform)
- Linux (servers, containers, WSL)
- Windows (via WSL primarily, native as stretch goal)

## Decision
We will support macOS and Linux as first-class platforms, with Windows support via WSL.

## Rationale
- **Swift support**: Swift has mature support for macOS and Linux
- **Common target**: Most dotfile users are on macOS or Linux
- **WSL bridge**: Windows users can use WSL for a Linux environment
- **Shared codebase**: Platform abstractions keep code unified

## Consequences
### Positive
- Single codebase for all platforms
- CI can test on macOS and Linux
- Docker support for Linux builds
- WSL users get full functionality

### Negative
- Native Windows support deferred
- Platform-specific code paths needed for some operations
- Testing matrix increases

## Platform Abstractions
Abstract the following platform-specific operations:
- Home directory resolution (`~` expansion)
- Path separators (though POSIX-style works on all targets)
- Symlink creation
- File permissions
- XDG directories on Linux

## Distribution Strategy
| Platform | Distribution Method |
|----------|---------------------|
| macOS | Homebrew, direct binary download |
| Linux | Direct binary, distro packages (future) |
| Windows | WSL installation via Linux binary |

## Build Matrix
- macOS: arm64 (Apple Silicon), x86_64 (Intel)
- Linux: arm64, x86_64
- Musl builds for fully static Linux binaries
