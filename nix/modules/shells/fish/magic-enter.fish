set -l cmd (commandline)
if test -z "$cmd"
    magic-enter-command
    commandline -f repaint
    return
end
commandline -f execute
