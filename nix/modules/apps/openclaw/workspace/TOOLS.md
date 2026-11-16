# TOOLS.md - Local Environment

- **Host:** p4x-desktop-nixos (NixOS, x86_64), managed declaratively from the rawkOS Nix flake.
- **Packages:** install nothing imperatively. Anything missing belongs in the Nix config; say what is needed instead of working around it.
- **Network:** the gateway is reachable on loopback and over NetBird (`*.rka.internal`).
- **Secrets:** live in 1Password. Never print, log, or store secret values in the workspace.
- **Workspace files:** `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, and `USER.md` are read-only and managed by Nix. Propose changes to them in chat. `memory/` and `DREAMS.md` are yours to write.
