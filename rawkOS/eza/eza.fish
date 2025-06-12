# eza.fish

# Enable eza completions and functions
if type -q eza
  # This command outputs shell script code that needs to be sourced.
  # It sets up autocompletion for eza.
  eza init fish | source
end

# Define standard options for eza based on the user's Nix configuration.
# These options will be applied to the common 'ls'-like aliases.
#
# Nix configuration reference:
# programs.eza = {
#   enable = true;
#   enableFishIntegration = true; # Handled by `eza init fish`
#
#   colors = "always";            # -> --color=always
#   git = true;                 # -> --git
#   icons = "always";             # -> --icons=always
#
#   extraOptions = [
#     "--time-style"              # -> --time-style=relative
#     "relative"
#     "--git-ignore"              # -> --git-ignore
#     "--group-directories-first" # -> --group-directories-first
#     "--no-quotes"               # -> --no-quotes
#   ];
# };
set -l EZA_DEFAULT_OPTIONS \
  --color=always \
  --git \
  --icons=always \
  --time-style=relative \
  --git-ignore \
  --group-directories-first \
  --no-quotes

# Common aliases for eza, incorporating the default options.
# Using 'alias' here creates functions in Fish, which is suitable for command replacements.
alias ls "eza $EZA_DEFAULT_OPTIONS"
alias ll "eza $EZA_DEFAULT_OPTIONS -l"                # long format
alias la "eza $EZA_DEFAULT_OPTIONS -a"                # all files (show hidden)
alias lla "eza $EZA_DEFAULT_OPTIONS -la"              # long format, all files
alias l. "eza $EZA_DEFAULT_OPTIONS -ld .*"            # list only hidden files/dirs in the current directory (GNU ls behavior)
alias ls. "eza $EZA_DEFAULT_OPTIONS -aD"              # list only hidden files/dirs in the current directory (eza specific)
alias lt "eza $EZA_DEFAULT_OPTIONS --tree"            # tree view
alias llt "eza $EZA_DEFAULT_OPTIONS --tree -l"        # tree view, long format
alias lS "eza $EZA_DEFAULT_OPTIONS --sort=size"       # sort by size (largest first)
alias ltS "eza $EZA_DEFAULT_OPTIONS --tree --sort=size" # tree view, sort by size
alias lsd "eza $EZA_DEFAULT_OPTIONS --only-dirs"      # list only directories (equivalent to `ls -d */` or `find . -maxdepth 1 -type d`)