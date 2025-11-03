# Magic Enter function
# When pressing enter on an empty line, runs a smart command based on context

function magic-enter
    set -l cmd (commandline)
    if test -z "$cmd"
        commandline -r (magic-enter-command)
        commandline -f suppress-autosuggestion
    end
    commandline -f execute
end
