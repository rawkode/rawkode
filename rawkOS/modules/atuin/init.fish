# atuin shell integration for fish
# Initialize atuin for fish shell

# Run atuin init for fish
if type -q atuin
    atuin init fish | source
end
