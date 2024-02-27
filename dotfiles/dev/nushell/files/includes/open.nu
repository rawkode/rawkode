def nuopen [arg, --raw (-r)] {
  if $raw {
    open -r $arg
  } else {
    open $arg
  }
}

alias open = ^open
