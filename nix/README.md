# rawkOS: Rawkode's Operating System

A comprehensive NixOS configuration system using flake-parts and modular architecture for managing multiple machines with different profiles.

## Overview

This repository contains a modular NixOS configuration that supports:
- **Multiple machine configurations** (Framework laptops, desktops)
- **Profile-based system composition** (base, desktop, development, AMD hardware)
- **Modern Nix features** (flakes, home-manager, disko, secure boot)
- **Wayland-first desktop environment** with Niri compositor and GNOME fallback
- **Development-oriented tooling** with comprehensive CLI utilities

## Architecture

### Flake Structure
- **flake.nix**: Main entry point using flake-parts for modular composition
- **modules/**: Modular system components organized by category
- **profiles/**: High-level system profiles (base, desktop, development, hardware)

### Key Components

#### Profiles (`modules/profiles/`)
- **base.nix**: Core system foundation with Nix flakes, networking, users
- **desktop.nix**: Desktop environment with Niri/GNOME toggle options
- **development.nix**: Development tools and environments
- **amd.nix**: AMD hardware optimizations

#### Machine Configurations (`modules/machines/`)
- **p4x-framework-nixos**: Framework 13 AMD laptop with power management
- **p4x-desktop-nixos**: Desktop workstation configuration  
- **p4x-laptop-nixos**: General laptop configuration

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

Use [cuenv](https://github.com/rawkode/cuenv) for development workflow:

```bash
# Install cuenv if not already available
nix profile install github:rawkode/cuenv

# See available development tasks  
cuenv run

# Execute specific development tasks
cuenv run <task-name>
```

### Home Manager Integration

Home manager configurations are integrated via flake inputs. User-specific configurations are managed in the `modules/home/` directory with categories for:
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

The development profile includes:
- Modern CLI tools (ripgrep, bat, eza, helix, delta)
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
1. Create `modules/machines/<machine-name>/default.nix`
2. Import appropriate profiles and hardware modules
3. Configure machine-specific settings (hostname, disk layout, etc.)

### Creating Custom Profiles  
1. Add new profile in `modules/profiles/<profile-name>.nix`
2. Import required modules and set appropriate defaults
3. Export as `flake.nixosModules.profiles-<name>`

### Desktop Environment Toggle
The desktop profile supports switching between Niri and GNOME:

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
