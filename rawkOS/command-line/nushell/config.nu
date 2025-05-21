$env.config.show_banner = false

def --env ghb [group?: string, repository?: string] {
    let path = $nu.home-path;
    cd $"($nu.home-path)/Code/src/github.com/($group)/($repository)"
};

def --env rkc [group?: string, repository?: string] {
    cd $"($nu.home-path)/Code/src/code.rawkode.academy/($group)/($repository)"
};

# Useful to keep around
# $env.config = (
#     $env.config
#     | upsert hooks.pre_execution [ {||
#         $env.repl_commandline = (commandline)
#         print $"Command: ($env.repl_commandline)"
#     } ]
# )

def is-git-repo []: [ nothing -> bool] {
  git rev-parse --is-inside-work-tree out+err> /dev/null
  if ($env.LAST_EXIT_CODE != 0) {
    return false
  }
  return true
}

$env.config.hooks = {
    pre_execution: [
        { ||
            if (commandline | is-empty) {
                if (is-git-repo ) {
                    git status --short
                }
            }
        }
    ]

    env_change: {
        PWD: [
            {|| if (is-git-repo) { git status --short } }
        ]
    }
}

source ./catppuccin.nu
