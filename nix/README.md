# rawkOS: Rawkode's Operating System

A comprehensive NixOS and nix-darwin configuration system using flake-parts and manifest-driven machine composition.

## Overview

This repository contains a modular NixOS configuration that supports:

- **Multiple machine configurations** (Framework laptops, desktops, macOS hosts)
- **Manifest-first machine composition** with capabilities and hardware traits
- **Modern Nix features** (flakes, home-manager, disko, secure boot)
- **Wayland-first desktop environment** with Niri compositor and GNOME fallback
- **Development-oriented tooling** with comprehensive CLI utilities

## Architecture

### Flake Structure

- **flake.nix**: Main entry point using flake-parts for modular composition
- **modules/**: Modular system components organized by category
- **modules/machines/**: Per-machine manifests that declare platform, users, capabilities, traits, and local overrides
- **modules/capabilities/**: Shared behavior bundles such as foundation, desktop, development, platform, and vpn

### Key Components

#### Capabilities (`modules/capabilities/`)

- **foundation**: Core system foundation with Nix, users, shells, networking, and Home Manager support
- **desktop**: Desktop environment with Niri/GNOME, portals, audio, fonts, and desktop apps
- **theming**: Shared Stylix configuration for graphical systems and Home Manager
- **peripherals-multipass**: Multipass packages, Linux device rules, and macOS signing integration
- **development**: Development tools and environments
- **vpn**: NetBird networking, opt-in per machine

#### Machine Configurations (`modules/machines/`)

- Each machine directory has a `manifest.nix`.
- Manifests declare the target platform, system, primary user, capabilities, hardware traits, and local machine modules.
- `modules/machines/default.nix` generates `nixosConfigurations`, `darwinConfigurations`, and Darwin package aliases from those manifests.

### Technology Stack

- **Boot**: Lanzaboote (secure boot) + systemd-boot
- **Disk**: Disko with BTRFS + encryption
- **Desktop**: Niri (Wayland compositor) with GNOME fallback
- **Audio**: PipeWire with ALSA/PulseAudio compatibility
- **Fonts**: Comprehensive font stack with Stylix theming
- **Security**: TPM2, encrypted storage

## Quick Start

### Prerequisites

- NixOS or Nix with flakes enabled
- Git for cloning the repository

### Building a Configuration

```bash
# Build specific machine configuration
nix build .#nixosConfigurations.p4x-framework-nixos.config.system.build.toplevel

# Build and switch (on target machine)
sudo nixos-rebuild switch --flake .#p4x-framework-nixos

```

### Using with cuenv (Development Workflow)

Use [cuenv](https://github.com/cuenv/cuenv) for development workflow:

```bash
# Install cuenv if not already available
nix profile install github:cuenv/cuenv

# One-time bootstrap for system trust + cache settings
# This seeds the active Nix daemon before your first real switch.
cuenv task bootstrap-cache

# Then run your normal switch
# nh darwin switch .    # macOS
# nh os switch .        # NixOS

# See available development tasks
cuenv task

# Format, lint, evaluate, and validate the manifest/output contract
cuenv task check

# Run all checks, then build this host without activating it
cuenv task check-host
```

`check-host` requires the local hostname to have a machine manifest. It builds the matching NixOS or nix-darwin system closure with `--no-link`; it does not switch or activate the configuration.

### Experimental devenv Machines pilot

The flake exports role modules generated from the machine manifests for use by
devenv Machines. The initial pilot declares only `p4x-studio`; its nix-darwin
role retains the integrated Home Manager configuration. This requires devenv
2.4 or later and reuses the flake's nixpkgs and nix-darwin inputs.

From this directory, inspect and build the machine without contacting it:

```bash
devenv machines info
devenv build machines.p4x-studio
```

To activate it over SSH after reviewing the build, run
`devenv machines deploy p4x-studio`. The target is `rawkode@p4x-studio` and
requires passwordless `sudo`; nix-darwin deployments do not have automatic
rollback. See the [devenv Machines guide](https://devenv.sh/machines/) for the
experimental interface and deployment behavior.

The `kree` and `multipass` inputs use sibling app flakes (`path:../apps/kree` and `path:../apps/multipass`), so evaluation expects this directory to remain inside the containing `rawkode` monorepo checkout.

Multipass is explicitly selected through the `peripherals-multipass` capability on every declared machine, including the work Mac and OrbStack VM. macOS copies the bundle to `~/Applications/Multipass.app` during activation so Spotlight indexes it and Input Monitoring grants survive rebuilds; Linux provides the `multipass` command and application-menu entry. NixOS also installs the narrowly scoped MX Master 4 Bluetooth HID access rule. Rebuild each host to apply the installation. Automatic startup and pairing are not configured: select that computer's mouse slot and pair through the app. Headless VMs receive the package but need a graphical session and Bluetooth device access to use it. NixOS network access still needs firewall configuration for mDNS and the peer TCP port advertised by Multipass (currently selected dynamically); installation does not open a broad port range.

### Home Manager Integration

Home Manager configurations are integrated through machine manifests, user modules, and capability-selected Home Manager imports. User-facing modules are organized by category under `modules/`:

- Command-line tools and editors
- Development environments
- AI tools and integrations
- Git and version control setup

## Machine-Specific Features

### Framework Laptop (p4x-framework-nixos)

- **Hardware**: Framework 13 AMD with nixos-hardware integration
- **Power Management**: Thermald, UPower, suspend-then-hibernate
- **Display**: HiDPI (200 DPI) with proper scaling
- **Input**: Touchpad with natural scrolling and tap-to-click
- **Security**: Fingerprint reader support
- **Connectivity**: WiFi power saving via systemd-networkd and iwd

### Desktop Systems

- **Graphics**: Hardware acceleration enabled
- **Audio**: Full PipeWire stack with low-latency
- **Peripherals**: QMK keyboard support, advanced input devices

## Development Environment

The development capability includes:

- Modern CLI tools (ripgrep, bat, eza, delta)
- Version control with Git and GitHub CLI integration
- Container tools and development frameworks
- AI-assisted development tools via nix-ai-tools
- Cloud development tools (Google Cloud SDK, etc.)

## Security Features

- **Secure Boot**: Lanzaboote integration with TPM attestation
- **Disk Encryption**: LUKS2 with BTRFS subvolumes
- **Authentication**: Fingerprint readers
- **Network Security**: NetBird mesh networking, DNS-over-HTTPS
- **Application Security**: Flatpak sandboxing for desktop applications

## Customization

### Adding a New Machine

1. Create `modules/machines/<machine-name>/manifest.nix`
2. Set `platform`, `system`, `primaryUser`, `users`, `capabilities`, and `traits`
3. Add host-local settings such as disk paths, swap, firmware, and one-off hardware overrides to the manifest's `modules` list

### Creating Custom Capabilities

1. Add a new capability in `modules/capabilities/<capability-name>/default.nix`
2. Compose existing app, system, Home Manager, NixOS, or Darwin modules with `mkCapability`
3. Add the capability name to the relevant machine manifest

### Foundation and host composition

`foundation` provides core system and user tooling. Desktop services belong to
`desktop`, Stylix belongs to `theming`, and Node.js/Podman belong to `development`.
Graphical machines explicitly select both `desktop` and `theming`. Hardware
services use `nixos-hardware-maintenance`, `nixos-tpm2`, and `nixos-wireless`
traits. Disk and Secure Boot modules import their own upstream dependencies.
Parallels explicitly retains its existing hardware-service selections; OrbStack
selects none of those traits and only keeps its container-specific integration.

Machine capabilities provide system integration and are inherited by users.
User-only capabilities provide Home Manager imports; they do not enable system
services. NixOS user selections of `desktop` or `theming` require the matching
machine capability, and desktop users require theming.

Host-local Home Manager settings belong in `users.<name>.modules`, so integrated
and standalone homes receive the same configuration. `users.<name>.editor`
overrides the user's default editor and also supplies the NixOS system editor
for the primary user. For example:

```nix
users.rawkode = {
  editor = "vim";
  modules = [ { rawkOS.apps.misc.ffmpeg.enable = false; } ];
};
```

The `eval-*` checks evaluate all public system/home derivations and headless
fixtures on either CI platform. CI runs each check in a fresh Nix process to
bound evaluator memory usage. `machine-composition` checks service ownership,
OrbStack home parity and the existing fleet's Multipass selections. Full fleet evaluation, including the
work Mac, is available through `cuenv task evaluate-machines` (or
`nix eval --json .#machineEvaluations`) and requires access to private CoreWeave
sources. Evaluation is distinct from a system build; run `cuenv task check-host`
on a target host before activation.

### Desktop Environment Toggle

The desktop capability supports switching between Niri and GNOME:

```nix
rawkOS.desktop = {
  niri.enable = true;   # Default Wayland compositor
  gnome.enable = false; # Traditional GNOME desktop
};
```

## Contributing

This is a personal configuration but contributions are welcome for:

- Bug fixes and improvements
- New hardware support modules
- Additional development tools integration
- Documentation improvements
