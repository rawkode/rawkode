# Magic Enter Command function
# Returns the smart command to run when enter is pressed on an empty line

function magic-enter-command
    set -l cmd ls

    if type -q jj
        jj root >/dev/null 2>&1
        if test $status -eq 0
            set cmd jj status
        end
    end

    if test "$cmd" = ls
        if type -q git
            git rev-parse --is-inside-work-tree >/dev/null 2>&1
            if test $status -eq 0
                set cmd git status --short
            end
        end
    end

    echo $cmd
end
