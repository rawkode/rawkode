let machine = (^hostname | str trim | split row "." | first)
let evaluation = (
	do -i {
		^nix eval --no-eval-cache --json .#machineManifests --apply 'builtins.mapAttrs (_: manifest: { inherit (manifest) platform system; })'
	} | complete
)

if $evaluation.exit_code != 0 {
	print --stderr $evaluation.stderr
	exit $evaluation.exit_code
}

let manifests = ($evaluation.stdout | from json)
let manifest = ($manifests | get -o $machine)

if $manifest == null {
	print --stderr $"No machine manifest found for local hostname '($machine)'"
	exit 1
}

let target = match $manifest.platform {
	"darwin" => $".#darwinConfigurations.($machine).system"
	"nixos" => $".#nixosConfigurations.($machine).config.system.build.toplevel"
	_ => {
		print --stderr $"Unsupported platform '($manifest.platform)' for machine '($machine)'"
		exit 1
	}
}

^nix build $target --no-link
