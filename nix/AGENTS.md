# Repository Guidelines

## Repository Workflow

- Use `jj` instead of Git when the Git root contains `.jj`. Before editing, inspect repository status, resolve the exact revision and requested scope, and preserve unrelated working-copy and history changes.
- Keep small, bounded changes small: work directly and run focused checks appropriate to the files. Do not add planning, delegation, architecture review, or broad refactoring just because several related files are involved.
- Update flake inputs with Nix tooling so `flake.nix` and `flake.lock` stay synchronized; do not hand-edit `flake.lock`.

## Homebrew Declarations

- Keep Homebrew resource types exact: `taps` declares tap repositories, `brews` declares formulae, and `casks` declares casks. Use the resource type published by the upstream tap, including a fully qualified cask when needed to select the intended tap.

## Low-Risk Package-List Changes

- A one-file Homebrew tap/formula/cask list change is low risk. For these changes, use focused status, diff, formatter, and parser checks; do not run the full architecture or adversarial-review workflow unless the change spans modules, changes architecture, or introduces a material integration risk.

## Project Structure & Module Organization

- Root flake (`flake.nix`) drives everything via flake-parts; inputs are pinned in `flake.lock`. Modules are auto-imported with import-tree — no manual import lists.
- `lib/` — the composition layer: `mkMachine` (builds nixos/darwin configurations from manifests), `mkUser`, `mkApp`, `mkCapability`, `capabilityResolver`, `machineManifest` (validation).
- Core code lives under `modules/` and is grouped by area:
  - `modules/machines/<name>/manifest.nix` — typed machine composition (platform, capabilities, traits, users) and host-local overrides.
  - `modules/capabilities/*` — `mkCapability` bundles referenced by manifests (foundation, desktop, development, …).
  - `modules/apps/*` and `modules/development/*` — `mkApp` definitions; one file yields home/nixos/darwin modules plus an `appBundles` entry.
  - `modules/config/*` — NixOS system config (hardware under `modules/config/hardware/`, security, networking, system).
  - `modules/linux/*` — Linux desktop environment (gnome, niri, ironbar, …).
  - `modules/users/*`, `modules/shells/*`, `modules/vcs/*` — user definitions via `mkUser` and their programs.
  - `modules/checks/*` — flake checks (treefmt, manifest contract).
  - `modules/coreweave/` — work-machine specifics.

## Build, Test, and Development Commands

- Enter dev shell (linters/formatters available): `nix develop`.
- Format all files (treefmt-nix): `nix fmt`.
- Run the canonical local validation: `cuenv task check`.
- Build and validate the current host without activating it: `cuenv task check-host`.
- Run the underlying flake checks directly: `nix flake check --no-eval-cache`.
- Build a NixOS system: `nix build .#nixosConfigurations.<machine>.config.system.build.toplevel`.
- Switch this repo on macOS/nix-darwin hosts: `nh darwin switch .`.
- Switch a NixOS target machine: `sudo nixos-rebuild switch --flake .#<machine>`.
- Discover outputs: `nix flake show`.
- Upgrade Determinate Nix: `sudo determinate-nixd upgrade`.

## Coding Style & Naming Conventions

- Nix formatting uses `nixfmt-rfc-style`; run `nix fmt` before committing.
- EditorConfig: LF endings, final newline, trim whitespace, indent with tabs (width 2).
- File naming: kebab-case for files/dirs; use `default.nix` inside module directories.
- Keep modules small, composable, and placed under the closest matching subtree (e.g., `modules/config/networking/…`).

## Testing Guidelines

- Primary validation is declarative: `cuenv task check` and successful builds of affected system configurations.
- For system changes, prefer a safe trial: `sudo nixos-rebuild test --flake .#<machine>` before `switch`.
- No unit-test suite is maintained; add lightweight evaluation checks if introducing complex logic.

## Commit & Pull Request Guidelines

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:` (see git history).
- PRs should include: clear description, affected machines/profiles, rationale, and sample commands/logs (e.g., build or `rebuild test`).
- Require clean `nix fmt` and `cuenv task check` before review.

## Security & Configuration Tips

- Do not commit secrets or machine-specific credentials.
- Hardware changes belong under `modules/config/hardware/…`; prefer opt-in via traits or capabilities.
- When unsure, add a focused module or capability rather than baking reusable settings into machines.
