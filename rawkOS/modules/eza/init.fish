# eza shell integration for fish
# eza is a modern replacement for ls

# Configure eza defaults
set -gx EZA_COLORS "always"
set -gx EZA_ICONS "always"

# Default eza options
set -l eza_opts --time-style=relative --group-directories-first --no-quotes --git --icons

# Basic ls replacement
alias ls="eza $eza_opts"
alias ll="eza $eza_opts -l"
alias la="eza $eza_opts -la"
alias lt="eza $eza_opts --tree"
alias l="eza $eza_opts -l"
