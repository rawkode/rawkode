package cuenv

project: {
	name:        "rawkOS"
	description: "Rawkode's Operating System"
}

env: {
	hooks: {
		onEnter: [
			{flake: dir: "."},
		]
	}
}

tasks: {
	"fmt": {
		description: "Format all code (Rust, Go, Nix, CUE, etc.)"
		command:     "treefmt"
		cache:       true
		inputs: ["**/*"]
	}

	"fresh-install-partition": {
		description: "Partition disk for fresh NixOS install"
		command:     "sudo nix --experimental-features \"nix-command flakes\" run github:nix-community/disko -- --mode disko ./systems/x86_64-linux/$DEVICE/disko.nix"
	}

	"fresh-install-install": {
		description: "Install NixOS on prepared partitions"
		script: """
			sudo nixos-install --no-root-passwd --root /mnt --no-bootloader --flake .#${DEVICE}
			sudo nixos-enter --root /mnt --command "sbctl create-keys"
			sudo nixos-install --no-root-passwd --root /mnt --flake .#${DEVICE}
			sudo nixos-enter --root /mnt --command "passwd rawkode"
			"""
	}

	"rebuild": {
		description: "Apply NixOS and home-manager configuration"
		command:     "nh os switch ."
	}

	"install-flatpaks": {
		description: "Install Flatpak applications"
		script: """
			flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

			flatpak install --system --or-update --assumeyes flathub org.zulip.Zulip
			flatpak install --system --or-update --assumeyes flathub com.slack.Slack
			flatpak install --system --or-update --assumeyes flathub com.discordapp.Discord
			flatpak install --system --or-update --assumeyes flathub com.feaneron.Boatswain
			flatpak install --system --or-update --assumeyes flathub com.rafaelmardojai.SharePreview
			flatpak install --system --or-update --assumeyes flathub com.spotify.Client
			flatpak install --system --or-update --assumeyes flathub com.usebottles.bottles
			flatpak install --system --or-update --assumeyes flathub es.danirod.Cartero
			flatpak install --system --or-update --assumeyes flathub io.github.pieterdd.RcloneShuttle
			flatpak install --system --or-update --assumeyes flathub net.mkiol.Jupii
			flatpak install --system --or-update --assumeyes flathub org.nickvision.tubeconverter
			flatpak install --system --or-update --assumeyes flathub org.gnome.Showtime
			"""
	}
}
