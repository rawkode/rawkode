# Magic Enter Command function
# Returns the smart command to run when enter is pressed on an empty line

function magic-enter-command
    set -l cmd ls
    set -l is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true)

    if test -n "$is_git_repository"
        set cmd git status --short
    end

    echo $cmd
end
