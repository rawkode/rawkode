$env.NIX_PATH = $'/Users/($env.USER)/.nix-defexpr/channels:darwin-config=/Users/($env.USER)/.nixpkgs/darwin-configuration.nix:/nix/var/nix/profiles/per-user/root/channels'

$env.NIX_PROFILES = $'/nix/var/nix/profiles/default /run/current-system/sw /etc/profiles/per-user/($env.USER) /Users/($env.USER)/.nix-profile'

$env.PATH = (
	$env.PATH
	| split row (char esep)
	| prepend $"/Users/($env.USER)/.nix-profile/bin"
	| prepend $"/etc/profiles/per-user/($env.USER)/bin"
	| prepend '/run/current-system/sw/bin/'
	| prepend '/nix/var/nix/profiles/default/bin'
	| prepend $"/Users/($env.USER)/.local/bin"
	| prepend $'/opt/homebrew/bin'
)

if ("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path exists) {
	$env.SSH_AUTH_SOCK = ("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path expand)
}
