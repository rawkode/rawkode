#!/usr/bin/env bash
# Run this script from inside the NixOS live ISO after booting the VM
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# Configuration
FLAKE_CONFIG="p4x-parallels-nixos"
DISK_DEVICE="/dev/sda"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           NixOS Parallels VM Automated Installer               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

# Check if disk exists
if [[ ! -b "$DISK_DEVICE" ]]; then
    log_error "Disk device $DISK_DEVICE not found"
    log_info "Available disks:"
    lsblk -d -o NAME,SIZE,TYPE
    exit 1
fi

# Clone or update the nix config repo
FLAKE_PATH="${FLAKE_PATH:-/tmp/nix}"

if [[ -d "$FLAKE_PATH/.git" ]]; then
    log_info "Updating existing repo at $FLAKE_PATH..."
    git -C "$FLAKE_PATH" pull
else
    log_info "Cloning nix config repo..."
    nix-shell -p git --run "git clone https://github.com/rawkode/nix $FLAKE_PATH"
fi

log_info "Using flake at: $FLAKE_PATH"
log_info "Target disk: $DISK_DEVICE"
log_info "Configuration: $FLAKE_CONFIG"
echo ""

# Confirmation
log_warn "This will ERASE ALL DATA on $DISK_DEVICE!"
echo ""
read -p "Are you sure you want to continue? (type 'yes' to confirm): " confirm
if [[ "$confirm" != "yes" ]]; then
    log_info "Aborted."
    exit 0
fi

echo ""
log_step "Step 1/4: Running disko to partition and format disk..."
nix --experimental-features "nix-command flakes" run github:nix-community/disko -- \
    --mode disko \
    --flake "$FLAKE_PATH#$FLAKE_CONFIG"

log_step "Step 2/4: Verifying mount points..."
if ! mountpoint -q /mnt; then
    log_error "Root filesystem not mounted at /mnt"
    exit 1
fi
log_info "Disk partitioned and mounted successfully"
lsblk "$DISK_DEVICE"

log_step "Step 3/4: Installing NixOS..."
nixos-install --flake "$FLAKE_PATH#$FLAKE_CONFIG" --no-root-passwd

log_step "Step 4/4: Setting up user password..."
log_info "Please set a password for the 'rawkode' user:"
nixos-enter --root /mnt -c 'passwd rawkode' || {
    log_warn "Failed to set password interactively."
    log_info "You can set it after first boot with: passwd rawkode"
}

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Installation Complete!                       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
log_info "You can now reboot into your new NixOS system:"
echo "  1. Shut down: shutdown now"
echo "  2. Eject the ISO in Parallels"
echo "  3. Start the VM"
echo ""
log_info "After first boot, rebuild with:"
echo "  cd $FLAKE_PATH && git pull"
echo "  sudo nixos-rebuild switch --flake $FLAKE_PATH#$FLAKE_CONFIG"
echo ""
