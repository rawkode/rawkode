#!/usr/bin/env nu

def log-info [message: string] {
	print $"(ansi green_bold)[INFO](ansi reset) ($message)"
}

def log-warn [message: string] {
	print $"(ansi yellow_bold)[WARN](ansi reset) ($message)"
}

def log-error [message: string] {
	print $"(ansi red_bold)[ERROR](ansi reset) ($message)"
}

def get-primary-hdd-device [vm_name: string] {
	let vm_info = (do -i { ^prlctl list --info $vm_name | complete })
	if $vm_info.exit_code != 0 {
		error make { msg: $"Failed to read VM info for ($vm_name)." }
	}

	let disks = (
		$vm_info.stdout
		| lines
		| where {|line| $line =~ '^\s*hdd\d+' }
	)

	if ($disks | is-empty) {
		""
	} else {
		($disks | first | str trim | split row ' ' | get 0)
	}
}

def configure-hdd-size [vm_name: string, disk_name: string, disk_mb: int] {
	let resize = (
		do -i { ^prlctl set $vm_name --device-set $disk_name --size ($disk_mb | into string) | complete }
	)
	if $resize.exit_code == 0 {
		return
	}

	let combined_output = $"($resize.stdout)\n($resize.stderr)"

	# Work around Parallels Desktop 26 disk resize bug (PRL_WRN_IT_EMPTY_MBR).
	if ($combined_output | str contains "PRL_WRN_IT_EMPTY_MBR") {
		log-warn $"Disk resize failed with PRL_WRN_IT_EMPTY_MBR; recreating ($disk_name) at ($disk_mb)MB."

		let delete_with_destroy = (
			do -i { ^prlctl set $vm_name --device-del $disk_name --destroy-image | complete }
		)
		if $delete_with_destroy.exit_code != 0 {
			let delete_without_destroy = (do -i { ^prlctl set $vm_name --device-del $disk_name | complete })
			if $delete_without_destroy.exit_code != 0 {
				if (($delete_with_destroy.stderr | str trim) != "") {
					print -e ($delete_with_destroy.stderr | str trim --right)
				}
				if (($delete_without_destroy.stderr | str trim) != "") {
					print -e ($delete_without_destroy.stderr | str trim --right)
				}
				error make { msg: $"Failed to remove disk ($disk_name)." }
			}
		}

		^prlctl set $vm_name --device-add hdd --size ($disk_mb | into string)
		return
	}

	if (($resize.stdout | str trim) != "") {
		print -e ($resize.stdout | str trim --right)
	}
	if (($resize.stderr | str trim) != "") {
		print -e ($resize.stderr | str trim --right)
	}
	error make { msg: $"Failed to resize disk ($disk_name)." }
}

def main [] {
	let arch = if ((^uname -m | str trim) == "arm64") { "aarch64" } else { "x86_64" }

	let vm_name = ($env.VM_NAME? | default "nixos")
	let iso_url = ($env.ISO_URL? | default $"https://channels.nixos.org/nixos-unstable/latest-nixos-minimal-($arch)-linux.iso")
	let iso_path = ($env.ISO_PATH? | default $"($env.HOME)/VMs/nixos-minimal-($arch).iso")
	let ram_mb = (($env.RAM_MB? | default "16384") | into int)
	let cpus = (($env.CPUS? | default "8") | into int)
	let disk_mb = (($env.DISK_MB? | default "200000") | into int)
	let vram_mb = (($env.VRAM_MB? | default "256") | into int)

	if (which prlctl | is-empty) {
		log-error "Parallels CLI (prlctl) not found. Please install Parallels Desktop."
		exit 1
	}

	mkdir ($iso_path | path dirname)
	if not ($iso_path | path exists) {
		log-info $"Downloading NixOS ISO to ($iso_path)..."
		^curl -L --progress-bar -o $iso_path $iso_url
		log-info "Download complete."
	} else {
		log-info $"ISO already exists at ($iso_path)"
	}

	let vm_list = (do -i { ^prlctl list --all | complete })
	if ($vm_list.exit_code == 0) and ($vm_list.stdout | str contains $vm_name) {
		log-warn $"VM '($vm_name)' already exists."
		print ""
		print "Options:"
		print $"  1. Start existing VM:    prlctl start \"($vm_name)\""
		print $"  2. Delete and recreate:  prlctl delete \"($vm_name)\" && ./scripts/create-nixos-vm.nu"
		print "  3. Open Parallels:       open -a 'Parallels Desktop'"
		exit 0
	}

	log-info $"Creating VM: ($vm_name)"
	^prlctl create $vm_name --ostype linux

	log-info $"Configuring VM hardware: ($ram_mb)MB RAM, ($cpus) CPUs, ($disk_mb)MB disk..."
	^prlctl set $vm_name --memsize ($ram_mb | into string)
	^prlctl set $vm_name --cpus ($cpus | into string)

	mut hdd_device = (get-primary-hdd-device $vm_name)
	if $hdd_device == "" {
		log-warn "Could not detect VM disk device name; defaulting to hdd0"
		$hdd_device = "hdd0"
	}

	configure-hdd-size $vm_name $hdd_device $disk_mb

	$hdd_device = (get-primary-hdd-device $vm_name)
	if $hdd_device == "" {
		log-warn "Could not re-detect VM disk device name after resize; defaulting to hdd0"
		$hdd_device = "hdd0"
	}

	log-info "Enabling 3D acceleration for Wayland..."
	^prlctl set $vm_name --3d-accelerate highest
	^prlctl set $vm_name --videosize ($vram_mb | into string)

	let nested_virt = (do -i { ^prlctl set $vm_name --nested-virt on | complete })
	if $nested_virt.exit_code != 0 {
		log-warn "Nested virtualization not available"
	}

	log-info "Attaching NixOS ISO..."
	^prlctl set $vm_name --device-set cdrom0 --image $iso_path
	^prlctl set $vm_name --device-set cdrom0 --connect

	^prlctl set $vm_name --device-bootorder $"cdrom0 ($hdd_device)"
	^prlctl set $vm_name --shared-clipboard on
	^prlctl set $vm_name --time-sync on

	print ""
	log-info $"VM '($vm_name)' created successfully!"
	print ""
	print "Next steps:"
	print "  1. Start the VM:"
	print $"     prlctl start \"($vm_name)\""
	print ""
	print "  2. In the VM console, run the installer:"
	print "     curl -fsSL https://raw.githubusercontent.com/rawkode/rawkode/main/nix/scripts/install-nixos-vm.nu -o /tmp/install-nixos-vm.nu"
	print "     sudo nu /tmp/install-nixos-vm.nu"
	print ""
	print "  3. After install completes, eject ISO and reboot"
	print ""
	print "  4. Future rebuilds:"
	print "     cd /tmp/rawkode/nix && git -C /tmp/rawkode pull"
	print "     sudo nixos-rebuild switch --flake /tmp/rawkode/nix#p4x-parallels-nixos"
}
