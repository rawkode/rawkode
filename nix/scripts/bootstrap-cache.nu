const BOOTSTRAP_ETC_ENTRY = "rawkos-nix-bootstrap.conf"
const BOOTSTRAP_BEGIN = "# BEGIN rawkOS bootstrap-cache"
const BOOTSTRAP_END = "# END rawkOS bootstrap-cache"
const CACHE_REGEX = 'ghostty\.cachix\.org|wezterm\.cachix\.org|cuenv\.cachix\.org|devenv\.cachix\.org'

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

def detect-platform [] {
	let kernel = (^uname -s | str trim)

	match $kernel {
		"Darwin" => {
			{
				platform_name: "nix-darwin"
				config_namespace: "darwinConfigurations"
			}
		}
		"Linux" => {
			if (not ("/etc/NIXOS" | path exists)) and ((which nixos-rebuild | is-empty)) {
				error make { msg: "Linux is supported only when this host is running NixOS." }
			}

			{
				platform_name: "NixOS"
				config_namespace: "nixosConfigurations"
			}
		}
		_ => {
			error make { msg: $"Unsupported platform: ($kernel)" }
		}
	}
}

def detect-host [host_name?: string] {
	if $host_name != null and $host_name != "" {
		return $host_name
	}

	let short_result = (do -i { ^hostname -s | complete })
	if $short_result.exit_code == 0 {
		let short_host = ($short_result.stdout | str trim)
		if $short_host != "" {
			return $short_host
		}
	}

	let host_result = (^hostname | str trim)
	if $host_result == "" {
		error make { msg: "Unable to determine hostname. Pass it as the first task argument." }
	}

	$host_result
}

def show-daemon-config [] {
	let matching_lines = (
		^nix config show
		| lines
		| where {|line|
			$line =~ 'trusted-users|substituters|trusted-public-keys|trusted-substituters|cachix|ghostty|wezterm|cuenv|devenv'
		}
	)

	$matching_lines | each {|line| print $line }
}

def daemon-has-project-caches [] {
	((^nix config show) =~ $CACHE_REGEX)
}

def evaluate-bootstrap-text [config_namespace: string, host_name: string] {
	let installable = $".#($config_namespace).\"($host_name)\".config.environment.etc.\"($BOOTSTRAP_ETC_ENTRY)\".text"
	^nix eval --raw $installable
}

def choose-target-file [] {
	if not ("/etc/nix/nix.conf" | path exists) {
		error make { msg: "/etc/nix/nix.conf does not exist." }
	}

	let nix_conf = (open --raw /etc/nix/nix.conf)
	if ($nix_conf =~ '(?m)^\s*!include\s+nix\.custom\.conf(?:\s|$)') {
		"/etc/nix/nix.custom.conf"
	} else {
		"/etc/nix/nix.conf"
	}
}

def strip-bootstrap-block [text: string] {
	mut output = []
	mut skipping = false

	for line in ($text | lines) {
		if $line == $BOOTSTRAP_BEGIN {
			$skipping = true
		} else if $line == $BOOTSTRAP_END {
			$skipping = false
		} else if not $skipping {
			$output = ($output | append $line)
		}
	}

	$output | str join (char nl)
}

def write-bootstrap-file [target_file: string, bootstrap_text: string] {
	let backup_file = $"($target_file).bak.((date now | format date '%Y%m%d%H%M%S'))"
	let temp_file = (^mktemp | str trim)
	let bootstrap_body = ($bootstrap_text | str trim --right)

	let new_content = if $target_file == "/etc/nix/nix.custom.conf" {
		$"($bootstrap_body)\n"
	} else {
		let existing = (open --raw $target_file)
		let cleaned = (strip-bootstrap-block $existing | str trim --right)

		if $cleaned == "" {
			$"($BOOTSTRAP_BEGIN)\n($bootstrap_body)\n($BOOTSTRAP_END)\n"
		} else {
			$"($cleaned)\n\n($BOOTSTRAP_BEGIN)\n($bootstrap_body)\n($BOOTSTRAP_END)\n"
		}
	}

	$new_content | save --force $temp_file

	if ($target_file | path exists) {
		^sudo cp $target_file $backup_file
	}

	^sudo install -m 644 $temp_file $target_file
	^rm -f $temp_file

	log-info $"Backed up ($target_file) to ($backup_file)"
}

def restart-daemon [platform_name: string] {
	log-step "Restarting Nix daemon"

	if $platform_name == "nix-darwin" {
		let determinate = (do -i { ^sudo launchctl kickstart -k system/systems.determinate.nix-daemon | complete })
		if $determinate.exit_code != 0 {
			let fallback = (do -i { ^sudo launchctl kickstart -k system/org.nixos.nix-daemon | complete })
			if $fallback.exit_code != 0 {
				error make { msg: "Failed to restart nix-darwin daemon." }
			}
		}
	} else {
		let result = (do -i { ^sudo systemctl restart nix-daemon.service | complete })
		if $result.exit_code != 0 {
			error make { msg: "Failed to restart nix-daemon.service." }
		}
	}
}

def main [host_name?: string] {
	let platform = (detect-platform)
	let resolved_host = (detect-host $host_name)

	log-info $"Detected ($platform.platform_name)"
	log-info $"Using host ($resolved_host)"

	if (daemon-has-project-caches) {
		log-info "Daemon cache config is already active."
		log-step "Current daemon config"
		show-daemon-config
		return
	}

	log-step "Evaluating bootstrap config from flake"
	let bootstrap_text = (evaluate-bootstrap-text $platform.config_namespace $resolved_host)

	let target_file = (choose-target-file)
	log-info $"Seeding ($target_file)"
	write-bootstrap-file $target_file $bootstrap_text

	restart-daemon $platform.platform_name

	log-step "Daemon config after bootstrap"
	show-daemon-config

	if not (daemon-has-project-caches) {
		log-error "Bootstrap completed, but daemon cache settings are still missing."
		exit 1
	}

	log-info "Daemon trust and cache config are active."
	log-info "Run your normal switch now."
}
