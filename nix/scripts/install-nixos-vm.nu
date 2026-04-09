#!/usr/bin/env nu
# Run this script from inside the NixOS live ISO after booting the VM.

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

def main [] {
	let flake_config = ($env.FLAKE_CONFIG? | default "p4x-parallels-nixos")
	let disk_device = ($env.DISK_DEVICE? | default "/dev/sda")
	let repo_url = ($env.REPO_URL? | default "https://github.com/rawkode/rawkode")
	let repo_path = ($env.REPO_PATH? | default "/tmp/rawkode")
	let flake_subdir = ($env.FLAKE_SUBDIR? | default "nix")
	let flake_path = ($env.FLAKE_PATH? | default $"($repo_path)/($flake_subdir)")

	print ""
	print "NixOS Parallels VM Automated Installer"
	print ""

	if ((^id -u | str trim) != "0") {
		log-error "This script must be run as root (use sudo)."
		exit 1
	}

	let disk_check = (do -i { ^test -b $disk_device | complete })
	if $disk_check.exit_code != 0 {
		log-error $"Disk device ($disk_device) not found."
		log-info "Available disks:"
		^lsblk -d -o NAME,SIZE,TYPE
		exit 1
	}

	let git_dir = ([$repo_path ".git"] | path join)
	if ($git_dir | path exists) {
		log-info $"Updating existing repo at ($repo_path)..."
		if (which git | is-empty) {
			^nix-shell -p git --run $"git -C '($repo_path)' pull"
		} else {
			^git -C $repo_path pull
		}
	} else {
		log-info $"Cloning repo: ($repo_url)"
		^nix-shell -p git --run $"git clone '($repo_url)' '($repo_path)'"
	}

	if not ($flake_path | path exists) {
		log-error $"Flake path does not exist: ($flake_path)"
		log-info $"Expected flake at repo subdirectory: ($flake_subdir)"
		exit 1
	}

	log-info $"Using flake at: ($flake_path)"
	log-info $"Target disk: ($disk_device)"
	log-info $"Configuration: ($flake_config)"
	print ""

	log-warn $"This will ERASE ALL DATA on ($disk_device)!"
	print ""
	let confirm = (input "Are you sure you want to continue? (type 'yes' to confirm): ")
	if $confirm != "yes" {
		log-info "Aborted."
		exit 0
	}

	print ""
	log-step "Step 1/4: Running disko to partition and format disk..."
	^nix --experimental-features "nix-command flakes" run github:nix-community/disko -- --mode disko --flake $"($flake_path)#($flake_config)"

	log-step "Step 2/4: Verifying mount points..."
	let mount_check = (do -i { ^mountpoint -q /mnt | complete })
	if $mount_check.exit_code != 0 {
		log-error "Root filesystem not mounted at /mnt."
		exit 1
	}
	log-info "Disk partitioned and mounted successfully."
	^lsblk $disk_device

	log-step "Step 3/4: Installing NixOS..."
	log-info "Raising open file limit to avoid 'too many open files' errors..."
	^ulimit -n 1048576
	^nixos-install --flake $"($flake_path)#($flake_config)" --no-root-passwd

	log-step "Step 4/4: Setting up user password..."
	log-info "Please set a password for the 'rawkode' user:"
	let passwd_result = (do -i { ^nixos-enter --root /mnt -c "passwd rawkode" | complete })
	if $passwd_result.exit_code != 0 {
		log-warn "Failed to set password interactively."
		log-info "You can set it after first boot with: passwd rawkode"
	}

	print ""
	print "Installation complete."
	print ""
	log-info "You can now reboot into your new NixOS system:"
	print "  1. Shut down: shutdown now"
	print "  2. Eject the ISO in Parallels"
	print "  3. Start the VM"
	print ""
	log-info "After first boot, rebuild with:"
	print $"  cd ($flake_path) && git pull"
	print $"  sudo nixos-rebuild switch --flake ($flake_path)#($flake_config)"
	print ""
}
