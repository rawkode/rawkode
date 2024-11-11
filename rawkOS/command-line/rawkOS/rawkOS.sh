#!/usr/bin/env bash
set -eoux pipefail

# Maybe move this to Amber or a Justfile
# but for now, simple script.

cat <<EOF >/usr/bin/rawkOS
#!/usr/bin/env bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | \
    sh -s -- install ostree --no-confirm --persistence=/var/lib/nix
echo "Defaults  secure_path = /nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:\$(sudo printenv PATH)" | sudo tee /etc/sudoers.d/nix-sudo-env
EOF
chmod +x /usr/bin/rawkOS
