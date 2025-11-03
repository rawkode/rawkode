# fzf shell integration for fish

# Enable fzf key bindings and fuzzy completion
if type -q fzf
    # Load fzf key bindings if available
    if test -f /usr/share/doc/fzf/examples/key-bindings.fish
        source /usr/share/doc/fzf/examples/key-bindings.fish
    end

    # fzf default options
    set -gx FZF_DEFAULT_OPTS '--height 40% --layout=reverse --border'
end
