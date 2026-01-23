# SPEC-0002: Configuration DSL

## Overview
This specification defines the Swift DSL used to configure managed dotfiles.

## Configuration File

The configuration lives in `Dotfile.swift` at the repository root.

## DSL Structure

### Top-Level Configuration

```swift
import DotfileKit

@main
struct MyDotfiles: DotfileConfiguration {
    var body: some DotfileContent {
        // File and template declarations
    }
}
```

### File Declaration

Declare a file to be symlinked:

```swift
File("zshrc")                           // Source: files/zshrc
    .target("~/.zshrc")                 // Target: ~/.zshrc

File("config/nvim")                     // Source: files/config/nvim (directory)
    .target("~/.config/nvim")           // Target: ~/.config/nvim
```

### Template Declaration

Declare a template to be rendered and symlinked:

```swift
Template("gitconfig")                   // Source: templates/gitconfig.swift
    .target("~/.gitconfig")             // Target: ~/.gitconfig
```

### Conditional Inclusion

Include files based on machine properties:

```swift
var body: some DotfileContent {
    File("zshrc").target("~/.zshrc")

    if Machine.os == .macos {
        File("macos/Brewfile")
            .target("~/.Brewfile")
    }

    if Machine.hostname.hasPrefix("work-") {
        File("work/npmrc")
            .target("~/.npmrc")
    }
}
```

### Groups

Organize related files:

```swift
Group("Shell") {
    File("zshrc").target("~/.zshrc")
    File("zsh/aliases").target("~/.zsh/aliases")
    File("zsh/functions").target("~/.zsh/functions")
}

Group("Editor") {
    File("config/nvim").target("~/.config/nvim")
    File("vimrc").target("~/.vimrc")
}
```

### Platform-Specific Targets

Different targets per platform:

```swift
File("shell/profile")
    .target(when: .macos, "~/.zprofile")
    .target(when: .linux, "~/.profile")
```

## Result Builder Implementation

```swift
@resultBuilder
public struct DotfileBuilder {
    public static func buildBlock(_ components: DotfileEntry...) -> [DotfileEntry]
    public static func buildOptional(_ component: [DotfileEntry]?) -> [DotfileEntry]
    public static func buildEither(first: [DotfileEntry]) -> [DotfileEntry]
    public static func buildEither(second: [DotfileEntry]) -> [DotfileEntry]
    public static func buildArray(_ components: [[DotfileEntry]]) -> [DotfileEntry]
}
```

## Types

### DotfileEntry Protocol

```swift
public protocol DotfileEntry {
    var source: Path { get }
    var targets: [ConditionalTarget] { get }
    var isTemplate: Bool { get }
}
```

### File

```swift
public struct File: DotfileEntry {
    public let source: Path
    public var targets: [ConditionalTarget] = []
    public let isTemplate = false

    public init(_ path: String)
    public func target(_ path: String) -> File
    public func target(when platform: Platform, _ path: String) -> File
}
```

### Template

```swift
public struct Template: DotfileEntry {
    public let source: Path
    public var targets: [ConditionalTarget] = []
    public let isTemplate = true

    public init(_ name: String)
    public func target(_ path: String) -> Template
}
```

### Machine Context

```swift
public enum Machine {
    public static var hostname: String
    public static var os: Platform
    public static var arch: Architecture
    public static var username: String
    public static var home: Path
}

public enum Platform {
    case macos
    case linux
    case windows
}

public enum Architecture {
    case arm64
    case x86_64
}
```

### Environment Access

```swift
public enum Environment {
    public static subscript(_ key: String) -> String?
}
```

## Compiled Configuration Output

The DSL compiles to a JSON manifest for the engine:

```json
{
  "version": 1,
  "entries": [
    {
      "source": "files/zshrc",
      "target": "~/.zshrc",
      "type": "file"
    },
    {
      "source": "templates/gitconfig.swift",
      "target": "~/.gitconfig",
      "type": "template"
    }
  ]
}
```

## Validation Rules

The configuration loader validates:

1. All source files exist
2. No duplicate targets
3. No circular dependencies (if we add includes)
4. Target paths are absolute or start with `~`
5. Templates have corresponding `.swift` files

## Example Complete Configuration

```swift
import DotfileKit

@main
struct MyDotfiles: DotfileConfiguration {
    var body: some DotfileContent {
        Group("Shell") {
            File("zshrc").target("~/.zshrc")
            File("zsh").target("~/.zsh")
        }

        Group("Git") {
            Template("gitconfig").target("~/.gitconfig")
            File("gitignore_global").target("~/.gitignore_global")
        }

        Group("Editor") {
            File("config/nvim").target("~/.config/nvim")

            if Machine.os == .macos {
                File("config/vscode/settings.json")
                    .target("~/Library/Application Support/Code/User/settings.json")
            }
        }

        if Machine.os == .macos {
            Group("macOS") {
                File("Brewfile").target("~/.Brewfile")
            }
        }
    }
}
```
