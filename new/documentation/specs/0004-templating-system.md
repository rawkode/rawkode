# SPEC-0004: Templating System

## Overview
This specification defines the Swift-native templating system for generating machine-specific configurations.

## Template Location

Templates are stored in the `templates/` directory with `.swift` extension:

```
~/.dotfiles/
└── templates/
    ├── gitconfig.swift
    ├── ssh_config.swift
    └── shell/
        └── exports.swift
```

## Template Structure

### Basic Template

```swift
// templates/gitconfig.swift
import DotfileKit

struct GitConfig: DotfileTemplate {
    var body: String {
        """
        [user]
            name = \(Machine.username)
            email = \(email)

        [core]
            editor = \(editor)
        """
    }

    var email: String {
        if Machine.hostname.contains("work") {
            return "me@work.com"
        }
        return "me@personal.com"
    }

    var editor: String {
        Environment["EDITOR"] ?? "vim"
    }
}
```

### Template Protocol

```swift
public protocol DotfileTemplate {
    associatedtype Body: StringProtocol
    var body: Body { get }
}
```

## Built-in Context

### Machine Namespace

```swift
public enum Machine {
    /// Current machine's hostname (e.g., "macbook-pro.local")
    public static var hostname: String

    /// Short hostname without domain (e.g., "macbook-pro")
    public static var shortHostname: String

    /// Operating system
    public static var os: Platform

    /// CPU architecture
    public static var arch: Architecture

    /// Current username
    public static var username: String

    /// Home directory path
    public static var home: String

    /// Number of CPU cores
    public static var cpuCount: Int

    /// Total system memory in bytes
    public static var memorySize: UInt64
}

public enum Platform: String, Equatable {
    case macos
    case linux
    case windows

    /// Human-readable name (e.g., "macOS", "Linux")
    public var displayName: String
}

public enum Architecture: String, Equatable {
    case arm64
    case x86_64

    /// Whether this is Apple Silicon
    public var isAppleSilicon: Bool
}
```

### Environment Access

```swift
public enum Environment {
    /// Get environment variable, returns nil if not set
    public static subscript(_ key: String) -> String?

    /// Get environment variable with default
    public static subscript(_ key: String, default defaultValue: String) -> String

    /// Check if variable is set
    public static func isSet(_ key: String) -> Bool
}
```

### Path Utilities

```swift
public enum Paths {
    /// Expand ~ to home directory
    public static func expand(_ path: String) -> String

    /// Join path components
    public static func join(_ components: String...) -> String

    /// Check if path exists
    public static func exists(_ path: String) -> Bool

    /// Check if path is directory
    public static func isDirectory(_ path: String) -> Bool
}
```

## Conditional Content

### If Expressions

```swift
var body: String {
    """
    # Common config
    export EDITOR=nvim

    \(if: Machine.os == .macos, """
    # macOS specific
    export HOMEBREW_PREFIX=/opt/homebrew
    """)

    \(if: Machine.os == .linux, """
    # Linux specific
    export PATH=$HOME/.local/bin:$PATH
    """)
    """
}
```

### Implementation

Custom string interpolation for conditionals:

```swift
extension String.StringInterpolation {
    mutating func appendInterpolation(if condition: Bool, _ value: String) {
        if condition {
            appendLiteral(value)
        }
    }

    mutating func appendInterpolation(
        if condition: Bool,
        _ ifTrue: String,
        else ifFalse: String
    ) {
        appendLiteral(condition ? ifTrue : ifFalse)
    }
}
```

## Loops

```swift
var body: String {
    let paths = ["/usr/local/bin", "/opt/homebrew/bin", "$HOME/.local/bin"]

    """
    export PATH=\(paths.joined(separator: ":"))
    """
}
```

## Includes

Include content from other files:

```swift
var body: String {
    """
    # Main config
    \(include("shared/aliases"))

    # Machine specific
    \(includeIfExists("local/\(Machine.shortHostname)"))
    """
}
```

```swift
public func include(_ path: String) -> String
public func includeIfExists(_ path: String) -> String
```

## Template Rendering

### Process

1. Template file is compiled as Swift code
2. `Machine`, `Environment`, and other context is populated
3. Template's `body` property is evaluated
4. Result is written to `.dotfiles/rendered/<name>`
5. Symlink points to rendered file

### Rendered Files Location

```
~/.dotfiles/
└── .dotfiles/
    └── rendered/
        ├── gitconfig
        └── ssh_config
```

### Re-rendering

Templates are re-rendered when:
- `dot sync` is run
- Template source file changes (detected via mtime)
- Machine context might have changed (e.g., hostname)

## Example Templates

### SSH Config

```swift
// templates/ssh_config.swift
import DotfileKit

struct SSHConfig: DotfileTemplate {
    var body: String {
        """
        # Generated by dotfiles - do not edit directly

        Host *
            AddKeysToAgent yes
            IdentitiesOnly yes
            \(if: Machine.os == .macos, "UseKeychain yes")

        Host github.com
            HostName github.com
            User git
            IdentityFile ~/.ssh/id_ed25519

        \(workHosts)
        """
    }

    var workHosts: String {
        guard Machine.hostname.contains("work") else { return "" }

        return """
        Host dev
            HostName dev.internal.company.com
            User \(Machine.username)
            IdentityFile ~/.ssh/work_key

        Host prod-*
            User deploy
            IdentityFile ~/.ssh/deploy_key
        """
    }
}
```

### Shell Exports

```swift
// templates/exports.swift
import DotfileKit

struct Exports: DotfileTemplate {
    var body: String {
        """
        # Path
        export PATH="\(paths.joined(separator: ":"))"

        # Editor
        export EDITOR="\(editor)"
        export VISUAL="$EDITOR"

        # Platform specific
        \(platformExports)
        """
    }

    var paths: [String] {
        var p = ["$HOME/.local/bin", "$HOME/bin"]

        if Machine.os == .macos {
            if Machine.arch == .arm64 {
                p.insert("/opt/homebrew/bin", at: 0)
            } else {
                p.insert("/usr/local/bin", at: 0)
            }
        }

        p.append("$PATH")
        return p
    }

    var editor: String {
        Environment["EDITOR"] ?? "nvim"
    }

    var platformExports: String {
        switch Machine.os {
        case .macos:
            return """
            export HOMEBREW_NO_ANALYTICS=1
            export HOMEBREW_NO_ENV_HINTS=1
            """
        case .linux:
            return """
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            """
        case .windows:
            return ""
        }
    }
}
```

## Validation

Templates are validated at compile time for:
- Swift syntax errors
- Undefined variables (caught by Swift compiler)
- Type mismatches

Runtime validation includes:
- Include file existence
- Environment variable warnings (optional variables that are unset)
