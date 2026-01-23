# ADR-0001: Swift as Implementation Language

## Status
Accepted

## Context
We need to choose a programming language for implementing a cross-platform dotfile manager. The tool needs to:
- Run on macOS, Linux, and WSL/Windows
- Provide a type-safe configuration DSL
- Handle file system operations efficiently
- Be distributable as a single binary

## Decision
We will implement the dotfile manager in Swift.

## Rationale
- **Cross-platform**: Swift supports macOS, Linux, and Windows via Swift on Server and cross-compilation
- **Type-safe DSL**: Swift's result builders and property wrappers enable expressive, type-safe configuration DSLs
- **Performance**: Compiled language with low memory footprint
- **Modern tooling**: Swift Package Manager provides dependency management and build tooling
- **String interpolation**: Swift's native string interpolation can serve as the templating system

## Consequences
### Positive
- Type-safe configuration catches errors at compile time
- Single binary distribution simplifies installation
- Native performance for file operations
- Strong ecosystem for CLI development (ArgumentParser, swift-log)

### Negative
- Smaller ecosystem compared to Go or Rust for CLI tools
- Linux/Windows support requires careful testing
- Users cannot easily modify the configuration DSL without recompiling
