# ADR-0005: Swift-Native Templating

## Status
Accepted

## Context
Dotfiles often need machine-specific values:
- Different email addresses (work vs personal)
- Machine-specific paths
- OS-specific configurations
- Hardware-dependent settings

Options considered:
- Mustache templates
- Jinja2-style templates (Stencil)
- Custom template syntax
- Swift string interpolation

## Decision
We will use Swift's native string interpolation as the templating system.

## Rationale
- **No new syntax**: Users already know Swift string interpolation
- **Full language power**: Conditionals, functions, computed properties
- **Type safety**: Template variables are typed Swift values
- **Consistency**: Same syntax as configuration DSL
- **Zero dependencies**: No external templating library needed

## Consequences
### Positive
- Templates are valid Swift code with full IDE support
- Complex logic (conditionals, loops) handled naturally
- Compile-time validation of template variables
- Can call Swift functions within templates

### Negative
- Templates must be valid Swift (steeper learning curve)
- Cannot edit templates without Swift knowledge
- Template files have `.swift` extension (may confuse some tools)

## Example Template
```swift
// gitconfig.swift
import DotfileManager

Template {
    """
    [user]
        name = \(config.name)
        email = \(config.email)

    [core]
        editor = \(Machine.editor ?? "vim")

    \(if: Machine.os == .macos) {
        """
        [credential]
            helper = osxkeychain
        """
    }
    """
}
```

## Built-in Variables
The templating system provides access to:
- `Machine.hostname` - current machine's hostname
- `Machine.os` - operating system (.macos, .linux, .windows)
- `Machine.arch` - architecture (.arm64, .x86_64)
- `Machine.username` - current user's name
- `Machine.home` - home directory path
- `Environment["KEY"]` - environment variable access
