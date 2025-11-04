# zoxide shell integration for fish
# Initialize zoxide and replace cd command

if type -q zoxide
    # Initialize zoxide with --cmd cd to replace the cd command
    zoxide init fish --cmd cd | source
end
