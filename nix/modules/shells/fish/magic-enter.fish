set -l cmd (commandline)
if test -z "$cmd"
    magic-enter-command
    commandline -f execute
    return
end

commandline -f execute
