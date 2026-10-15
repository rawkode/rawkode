#!/usr/bin/env nu
# Install a rawkOS NixOS machine from the NixOS live ISO.
#
# Run as root from the live ISO:
#
#   sudo -i
#   nix-shell -p git --run "git clone https://github.com/rawkode/rawkode /tmp/rawkode"
#   nix --experimental-features "nix-command flakes" shell \
#     nixpkgs#nixVersions.latest nixpkgs#nushell nixpkgs#git nixpkgs#sbctl \
#     -c nu /tmp/rawkode/nix/scripts/install.nu p4x-desktop-nixos
#
# The live ISO's Nix is too old to resolve the flake's `path:../apps/*` inputs
# from the `nix/` subdirectory, so the shell above provides a current Nix and the
# flake is referenced as `git+file://<repo>?dir=nix` to copy the whole monorepo.

def log-info [message: string] {
	print $"(ansi green_bold)[INFO](ansi reset) ($message)"
}

def log-warn [message: string] {
	print $"(ansi yellow_bold)[WARN](ansi reset) ($message)"
}

def log-error [message: string] {
	print $"(ansi red_bold)[ERROR](ansi reset) ($message)"
}

def log-step [message: string] {
	print $"(ansi blue_bold)[STEP](ansi reset) ($message)"
}

def main [
	machine: string # Machine name from modules/machines (e.g. p4x-desktop-nixos)
	--repo-path: string = "/tmp/rawkode" # Monorepo checkout on the live ISO
	--skip-disko # Disk is already partitioned and mounted at /mnt
	--user: string = "rawkode" # User to set a password for
] {
	if ((^id -u | str trim) != "0") {
		log-error "This script must be run as root (use sudo -i)."
		exit 1
	}

	if not ([$repo_path ".git"] | path join | path exists) {
		log-error $"No git checkout at ($repo_path)."
		exit 1
	}

	let flake = $"git+file://($repo_path)?dir=nix"
	let attr = $"($flake)#nixosConfigurations.($machine).config"

	log-info $"Nix: (^nix --version | str trim)"
	log-info $"Flake: ($flake)#($machine)"

	log-step "Evaluating machine configuration..."
	let disk = (^nix eval --raw $"($attr).rawkOS.disko.device")
	let secureboot = ((^nix eval --json $"($attr).boot.lanzaboote.enable" | from json) == true)
	log-info $"Target disk: ($disk)"
	log-info $"Secure Boot (lanzaboote): ($secureboot)"

	if not $skip_disko {
		if (do -i { ^test -b $disk | complete }).exit_code != 0 {
			log-error $"Disk device ($disk) not found."
			^lsblk -d -o NAME,SIZE,MODEL
			exit 1
		}

		^lsblk -d -o NAME,SIZE,MODEL
		log-warn $"This will ERASE ALL DATA on ($disk)!"
		let confirm = (input "Type 'yes' to continue: ")
		if $confirm != "yes" {
			log-info "Aborted."
			exit 0
		}

		log-step "Partitioning, encrypting, and mounting disk with disko..."
		^nix run github:nix-community/disko -- --mode disko --flake $"($flake)#($machine)"
	}

	if (do -i { ^mountpoint -q /mnt | complete }).exit_code != 0 {
		log-error "Root filesystem not mounted at /mnt."
		exit 1
	}

	if $secureboot {
		log-step "Creating Secure Boot keys..."
		# sbctl reports any EPERM as "requires root", so use its default location
		# on the live ISO and copy the keys into the target system.
		if not ("/var/lib/sbctl/keys" | path exists) {
			^sbctl create-keys
		}
		^mkdir -p /mnt/var/lib
		^cp -a /var/lib/sbctl /mnt/var/lib/
	}

	log-step "Installing NixOS..."
	# The live ISO root is RAM-backed, so give from-source builds real swap.
	let swapfile = "/mnt/installer-swapfile"
	if not ($swapfile | path exists) {
		^fallocate -l 32G $swapfile
		^chmod 600 $swapfile
		^mkswap $swapfile
	}
	do -i { ^swapon $swapfile }

	# ulimit is a shell builtin, so raise it in the same process as nixos-install.
	^bash -c $"ulimit -n 1048576; exec nixos-install --flake '($flake)#($machine)' --no-root-passwd"

	do -i { ^swapoff $swapfile }
	do -i { ^rm -f $swapfile }

	log-step $"Setting password for ($user)..."
	let passwd = (do -i { ^nixos-enter --root /mnt -c $"passwd ($user)" | complete })
	if $passwd.exit_code != 0 {
		log-warn $"Failed to set password. Run: nixos-enter --root /mnt -c 'passwd ($user)'"
	}

	print ""
	log-info "Installation complete. Remove the USB stick and reboot."
	if $secureboot {
		print ""
		log-info "After first boot, enable Secure Boot:"
		print "  1. sudo sbctl verify"
		print "  2. Put the firmware's Secure Boot into Setup Mode and boot again"
		print "  3. sudo sbctl enroll-keys --microsoft"
		print "  4. Reboot, enable Secure Boot in the firmware"
	}
}
