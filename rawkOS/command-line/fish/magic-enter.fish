if status is-interactive
    bind \r magic-enter
end

function magic-enter
    set -l cmd (commandline)
    if test -z "$cmd"
        commandline -r (magic-enter-command)
        commandline -f suppress-autosuggestion
    end
    commandline -f execute
end

function magic-enter-command
    set -l cmd ll
    set -l is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true)

    if test -n "$is_git_repository"
        set -l repo_has_changes (git status -s --ignore-submodules=dirty)
        if test -n "$repo_has_changes"
            set cmd git status
        end
    end

    echo $cmd
end
