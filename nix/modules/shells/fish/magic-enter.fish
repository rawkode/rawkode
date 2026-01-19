set -l cmd (commandline)
if test -z "$cmd"
    commandline -r (magic-enter-command)
    commandline -f suppress-autosuggestion
end
commandline -f execute
