# Nix environment integration for Fish shell
# Provides proper environment setup when using Nix

# Only initialize if nix exists
if command -q nix
    # Add nix binaries to path if not already present
    if not contains /nix/var/nix/profiles/default/bin $PATH
        fish_add_path /nix/var/nix/profiles/default/bin
    end

    # Add user nix profile if it exists
    if test -d ~/.nix-profile/bin; and not contains ~/.nix-profile/bin $PATH
        fish_add_path ~/.nix-profile/bin
    end
end
