use std/util "path add"

$env.CARGO_HOME = $nu.home-path | path join ".cargo"
path add ($env.CARGO_HOME | path join "bin")
