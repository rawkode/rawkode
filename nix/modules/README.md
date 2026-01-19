# Module Organization

This document explains how modules are organized and where new modules should go.

## Structure

```
modules/
├── apps/           # Standalone applications (Rule 5)
├── development/    # Build platforms (Rule 2)
├── linux/          # Linux DE config (Rule 3)
├── macos/          # macOS system utilities (Rule 3)
├── shells/         # Shell ecosystem (Rule 1)
├── vcs/            # Version control (Rule 4)
├── config/         # System configuration modules
├── machines/       # Machine-specific configurations
├── profiles/       # Composable profiles
└── users/          # User-specific configurations
```

## Rules for Placing New Modules

### Rule 1: Shell Integration Test → `shells/`

**If it requires shell hooks or modifies shell behavior, it belongs in `shells/`.**

Test: Does it need `eval "$(x init <shell>)"` or shell-specific configuration?

Examples:
- fish, nushell → ARE shells
- starship → modifies prompt, needs `starship init`
- atuin → replaces history, needs `atuin init`
- zoxide → replaces cd, needs `zoxide init`
- carapace → provides completions, needs shell config

Counter-examples:
- jq → standalone binary, no shell integration
- ripgrep → standalone binary, no shell integration

### Rule 2: Software Creation Platform → `development/`

**If it's a platform/runtime you BUILD software with, it belongs in `development/`.**

Test: Do you write code in/for it, or use it to build/deploy software?

Examples:
- go, rust, python → you write code in these languages
- bun, deno → runtimes you write JS/TS for
- cue → configuration language you write
- docker, podman → platforms you build containers with
- kubernetes → platform you deploy to
- pulumi, dagger → platforms for IaC/CI
- devenv, direnv, flox → dev environment tooling

Counter-examples:
- firefox → you don't build software with it
- htop → you don't build software with it
- zed → editor is an APP you use (even though it's for coding)

**Note:** Editors (zed, vscode, helix) are apps because they're interactive tools you USE, not platforms you build ON. The code you write targets go/rust/docker, not the editor.

### Rule 3: OS-Specific System Config → `linux/` or `macos/`

**If it only exists on one OS AND configures the system/DE, it goes in the OS folder.**

Examples:
- Linux DE (gnome, niri, bars, compositors) → `linux/`
- macOS system utilities (alt-tab, betterdisplay) → `macos/`

Note: Cross-platform apps that happen to use homebrew on macOS still go in `apps/`.

### Rule 4: Version Control → `vcs/`

**Git and alternatives are their own cohesive ecosystem.**

Git has enough related tooling (delta, gitsign, github cli) that it warrants its own module.

### Rule 5: Everything Else → `apps/`

**Standalone tools and applications that don't fit above.**

If you can run it as a standalone command without shell integration, and it's not a build platform, it's an app.

## Quick Reference

| Tool | Location | Why |
|------|----------|-----|
| fzf | `apps/` | Standalone fuzzy finder, no shell init required |
| atuin | `shells/` | Requires `eval "$(atuin init fish)"` |
| bun | `development/` | Runtime you write JS for |
| htop | `apps/` | Standalone process viewer |
| zed | `apps/` | Editor is a tool you USE, not build ON |
| docker | `development/` | Platform you build containers with |
| gnome-tweaks | `linux/` | Linux-only, configures DE |
| raycast | `macos/` | macOS-only, system launcher |

## Module Format

Each module should be a directory with a `default.nix`:

```
apps/
└── my-app/
    └── default.nix
```

For complex modules with additional files:

```
apps/
└── my-app/
    ├── default.nix
    ├── config.nix
    └── themes/
```
