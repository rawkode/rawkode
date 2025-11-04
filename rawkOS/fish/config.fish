# Fish shell configuration

# Remove greeting
set fish_greeting ""

# Editor
set -Ux EDITOR "code --wait"

# Disable autosuggestions
set fish_autosuggestion_enabled 0

# Shell aliases
alias ghb="cd ~/Code/src/github.com"

# Keybindings
# Ctrl-[ to go to parent directory
bind ctrl-\[ "builtin cd ..; commandline -f repaint"

# Magic enter - bind enter key to smart command
bind \r magic-enter

# Source git abbreviations if available
if test -f (dirname (status --current-filename))/git-abbr.fish
    source (dirname (status --current-filename))/git-abbr.fish
end
