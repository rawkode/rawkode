let excluded = "coreweave"

if not ("flake.lock" | path exists) {
	print "flake.lock is missing."
	print "Restore it first so excluded/private inputs stay pinned:"
	print "  git restore flake.lock"
	exit 1
}

let metadata = (do -i { ^nix flake metadata --json | from json })

if (($metadata | describe) == "nothing") {
	print "Failed to read flake metadata."
	print "Check network/auth for flake inputs (for example: coreweave)."
	exit 1
}

$metadata
| get -o locks.nodes.root.inputs
| default {}
| columns
| where {|input| $input != $excluded }
| each {|input| ^nix flake update --update-input $input }
