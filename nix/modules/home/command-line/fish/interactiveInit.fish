set fish_greeting ""
bind \r magic-enter

eval (zellij setup --generate-auto-start fish | string collect)

set -Ux EDITOR "code --wait"
