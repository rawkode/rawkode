# Source global configuration
PATH="/nix/var/nix/profiles/default/bin${PATH+:$PATH}"
. /nix/var/nix/profiles/default/etc/profile.d/nix.sh 2>/dev/null

# Set default channels
NIX_STATE_HOME=${XDG_STATE_HOME-$HOME/.local/state}/nix
if [ ! -r "${NIX_STATE_HOME}/channels" ]; then
    mkdir -p "${NIX_STATE_HOME}"
    echo 'https://nixos.org/channels/nixpkgs-unstable nixpkgs' >"${NIX_STATE_HOME}/channels"
fi
# Append `defexpr/channels` to NIX_PATH
if [ -r "${NIX_STATE_HOME}/defexpr/channels" ]; then
    export NIX_PATH=${NIX_PATH:+$NIX_PATH:}${NIX_STATE_HOME}/defexpr/channels
elif [ -r "${HOME}/.nix-defexpr/channels" ]; then
    export NIX_PATH=${NIX_PATH:+$NIX_PATH:}$HOME/.nix-defexpr/channels
fi
unset NIX_STATE_HOME
