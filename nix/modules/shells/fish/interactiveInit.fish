set fish_greeting ""
bind \r magic-enter

set -Ux EDITOR "hx"
set fish_autosuggestion_enabled 0

# Ensure nix-darwin per-user profile is in PATH (for home-manager packages with useUserPackages)
fish_add_path --prepend /etc/profiles/per-user/$USER/bin
