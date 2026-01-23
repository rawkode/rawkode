# ADR-0004: Swift DSL for Configuration

## Status
Accepted

## Context
The tool needs a configuration format to define:
- Which files to manage
- Source to target path mappings
- Machine-specific variations
- Templating variables

Options considered:
- YAML
- TOML
- JSON
- Swift DSL

## Decision
We will use a Swift-based Domain Specific Language (DSL) for configuration.

## Rationale
- **Type safety**: Configuration errors caught at compile time
- **IDE support**: Autocompletion, refactoring, inline documentation
- **Expressiveness**: Swift's syntax enables clean, readable configs
- **Validation**: Complex validation logic expressible naturally
- **Consistency**: Same language for tool and configuration

## Consequences
### Positive
- Impossible to write syntactically invalid configuration
- Rich tooling support in Xcode and VS Code
- Can embed Swift logic for complex conditional configurations
- Configuration is version-controlled Swift code

### Negative
- Requires Swift toolchain to "compile" configuration
- Higher barrier to entry than YAML/TOML
- Configuration changes require rebuild

## Example Configuration
```swift
import DotfileManager

let config = Dotfiles {
    File("zshrc")
        .target("~/.zshrc")

    File("config/nvim")
        .target("~/.config/nvim")

    Template("gitconfig.swift")
        .target("~/.gitconfig")
        .variables {
            Variable("name", value: "Rawkode")
            Variable("email", value: Machine.hostname.contains("work")
                ? "work@example.com"
                : "personal@example.com")
        }
}
```

## Implementation Notes
- Configuration lives in a `Dotfile.swift` file in repository root
- Swift Package Manager compiles and executes the configuration
- Result builders provide the DSL syntax
