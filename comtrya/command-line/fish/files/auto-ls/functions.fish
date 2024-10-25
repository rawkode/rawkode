function auto-ls
    set cmd (commandline)
    if test -z "$cmd"
        commandline -r (auto-ls-command)
        commandline -f suppress-autosuggestion
    end
    commandline -f execute
end

function auto-ls-command
    set cmd ll
    set is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true) # Special variable indicating git.
    set repo_has_changes (git status -s --ignore-submodules=dirty)

    if test -n "$is_git_repository"
        if test -n "$repo_has_changes"
            set cmd git status
        end
    end

    echo $cmd
end
