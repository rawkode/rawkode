$env.config = ($env.config? | default {})
$env.config.hooks = ($env.config.hooks? | default {})
$env.config.hooks.pre_execution = (
  $env.config.hooks.pre_execution?
  | default []
  | append {||
    let cmd = (commandline | str trim)

    if $cmd == "" {
      run-external eza
      if (do { git rev-parse --is-inside-work-tree } | complete).exit_code == 0 {
        run-external "git" "status"
      }
    }
  }
)
