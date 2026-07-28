# Repository Guidelines

## Project Structure & Module Organization

- Root flake (`flake.nix`) drives everything via flake-parts; inputs are pinned in `flake.lock`.
- Core code lives under `modules/` and is grouped by area:
  - `modules/machines/<name>/manifest.nix` — typed machine composition and host-local overrides.
  - `modules/capabilities/*` — reusable high-level behavior bundles.
  - `modules/nixos/*` and `modules/home/*` — system and Home Manager modules.
  - `modules/macos/*` — focused nix-darwin modules.
  - Assets: `modules/packages/wallpapers/`.

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
- Keep modules small, composable, and placed under the closest matching subtree (e.g., `modules/nixos/networking/…`).

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
- Hardware changes belong under `modules/nixos/hardware/…`; prefer opt-in via traits or capabilities.
- When unsure, add a focused module or capability rather than baking reusable settings into machines.
