let excluded = "coreweave"

^nix flake metadata --json
| from json
| get locks.nodes.root.inputs
| columns
| where {|input| $input != $excluded }
| each {|input| ^nix flake update --update-input $input }
