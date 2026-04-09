set fish_greeting ""
bind \r magic-enter

set -l default_editor "zed --wait"
set -Ux EDITOR $default_editor
set -Ux VISUAL $default_editor
set -Ux SUDO_EDITOR $default_editor
set -Ux SYSTEMD_EDITOR $default_editor
set fish_autosuggestion_enabled 0

# Ensure nix-darwin per-user profile is in PATH (for home-manager packages with useUserPackages)
# Append so that Homebrew (if present) can take precedence
fish_add_path --append /etc/profiles/per-user/$USER/bin

# Add Homebrew to PATH on macOS if present (prefer ahead of Nix)
if test -d /opt/homebrew/bin
  fish_add_path --prepend /opt/homebrew/bin /opt/homebrew/sbin
end
