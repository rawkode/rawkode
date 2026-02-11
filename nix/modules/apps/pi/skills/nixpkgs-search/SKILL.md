---
name: nixpkgs-search
description: Search nixpkgs packages by keyword or regex using nix search. Use this when you need package names, attribute paths, and short descriptions from nixpkgs.
---

# Nixpkgs Search

Use this skill to quickly find packages in nixpkgs.

## When to use

- You need to discover package names in nixpkgs.
- You need the attribute path for a package.
- You want machine-readable search output for further filtering.

## Prerequisites

- `nix` is installed and available on `PATH`.
- Network access is available to resolve the nixpkgs flake source.
- If your Nix config does not already enable it, `nix-command` and `flakes` experimental features may be required.

## Usage

Run the helper script from anywhere in the repo:

```bash
./.pi/skills/nixpkgs-search/search.sh <query>
```

Examples:

```bash
# Human-readable output
./.pi/skills/nixpkgs-search/search.sh ripgrep

# Multi-word query
./.pi/skills/nixpkgs-search/search.sh "postgres client"

# JSON output for tooling
./.pi/skills/nixpkgs-search/search.sh --json ripgrep | jq .

# JSON only (suppress diagnostics from stderr)
./.pi/skills/nixpkgs-search/search.sh --json ripgrep 2>/dev/null | jq .

# Search a specific flake ref instead of default nixpkgs
./.pi/skills/nixpkgs-search/search.sh --flake github:NixOS/nixpkgs/nixos-unstable firefox
```

## Arguments

- `--json`: return structured JSON output from `nix search` (stdout remains JSON; nix diagnostics may still be printed on stderr).
- `--flake <ref>`: override flake reference (default: `nixpkgs`).
- `-h`, `--help`: show usage.

## Troubleshooting

If search fails:

1. Confirm Nix is installed:
   ```bash
   nix --version
   ```
2. Try enabling required features explicitly:
   ```bash
   nix --extra-experimental-features 'nix-command flakes' search nixpkgs <query>
   ```
3. Check your network and flake access.

## Notes for agent usage

- Start with a broad query, then narrow with more specific terms.
- Prefer `--json` when results need post-processing or deterministic extraction.
- Report both package display name and attribute path when available.
