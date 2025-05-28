$env.config = {
    show_banner: false

    # I use Atuin
    history: {
        max_size: 0
    }

    completions: {
        case_sensitive: false
        quick: true
        algorithm: prefix
        partial: false
    }

    rm: {
        always_trash: true
    }

    buffer_editor: [
        "zeditor",
        "--wait",
        "--add"
    ]

    ls: {
        clickable_links: true
    }

    table: {
        mode: "rounded"
    }
}

def --env ghb [group?: string, repository?: string] {
    let path = $nu.home-path;
    cd $"($nu.home-path)/Code/src/github.com/($group)/($repository)"
};

def --env rkc [group?: string, repository?: string] {
    cd $"($nu.home-path)/Code/src/code.rawkode.academy/($group)/($repository)"
};

def --env gr [] {
	cd (git rev-parse --show-toplevel)
}

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
