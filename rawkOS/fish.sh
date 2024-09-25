#!/usr/bin/env bash
set -eoux pipefail

rpm-ostree install fish

# We add this, because on fresh installs, my shell will be bash
# and it's likely I'll install Nix with that configured.
# In this case, the installer prefers bash with /etc/profile.d
# but not fish.
# This means when I eventually change my shell, we lose the XDG_DATA_DIRS
# config that makes my GNOME extensions work
mkdir -p /etc/fish/conf.d
cat <<EOF | sudo tee /etc/fish/conf.d/nix.sh
if test -e '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.fish'
    . '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.fish'
end
EOF
