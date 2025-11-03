# television shell integration for fish

# Enable fish integration if television is installed
if type -q tv
    # Bind Ctrl+G to launch git-repos channel
    bind \cg 'tv git-repos'
end
