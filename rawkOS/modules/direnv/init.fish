# direnv shell integration for fish
# Initialize direnv hooks

if type -q direnv
    direnv hook fish | source
end
