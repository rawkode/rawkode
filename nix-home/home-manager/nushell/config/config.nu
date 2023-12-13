let fish_completer = {|spans|
    fish --command $'complete "--do-complete=($spans | str join " ")"'
    | $"value(char tab)description(char newline)" + $in
    | from tsv --flexible --no-infer
}

let zoxide_completer = {|spans|
    $spans | skip 1 | zoxide query -l $in | lines | where {|x| $x != $env.PWD}
}

let carapace_completer = {|spans: list<string>|
    carapace $spans.0 nushell $spans
    | from json
    | if ($in | default [] | where value =~ '^-.*ERR$' | is-empty) { $in } else { null }
}

let external_completer = {|spans|
  let expanded_alias = (scope aliases | where name == $spans.0 | get -i 0 | get -i expansion)

  let spans = (
    if $expanded_alias != null  {
      $spans | skip 1 | prepend ($expanded_alias | split row " ")
    } else { $spans }
  )

  match $spans.0 {
    nu => $fish_completer
    git => $fish_completer
    kubectl => $fish_completer
    __zoxide_z => $zoxide_completer
    __zoxide_zi => $zoxide_completer
    _ => $carapace_completer
  } | do $in $spans
}

$env.config = {
	show_banner: false
	use_ansi_coloring: true
	    completions: {
        external: {
            enable: true
            completer: $external_completer
        }
    }
}
