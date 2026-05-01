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
- **machines/**: Per-machine manifests that declare platform, users, capabilities, traits, and local overrides
- **capabilities/**: Shared behavior bundles such as foundation, desktop, development, platform, and tailnet

### Key Components

#### Capabilities (`modules/capabilities/`)

- **foundation**: Core system foundation with Nix, users, shells, networking, and Home Manager support
- **desktop**: Desktop environment with Niri/GNOME, portals, audio, fonts, and desktop apps
- **development**: Development tools and environments
- **tailnet**: Tailscale networking, opt-in per machine

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

# Build installation ISO
nix build .#nixosConfigurations.installer.config.system.build.isoImage
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

# Execute specific development tasks
cuenv task <task-name>
```

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
- **Network Security**: Tailscale mesh networking, DNS-over-HTTPS
- **Application Security**: Flatpak sandboxing for desktop applications

## Customization

### Adding a New Machine

1. Create `modules/machines/<machine-name>/manifest.nix`
2. Set `platform`, `system`, `primaryUser`, `users`, `capabilities`, and `traits`
3. Put host-local settings such as disk paths, swap, firmware, and one-off hardware overrides in `modules`

### Creating Custom Capabilities

1. Add a new capability in `modules/capabilities/<capability-name>/default.nix`
2. Compose existing app, system, Home Manager, NixOS, or Darwin modules with `mkCapability`
3. Add the capability name to the relevant machine manifest

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
