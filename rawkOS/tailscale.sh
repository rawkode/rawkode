#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF >/etc/yum.repos.d/tailscale.repo
[tailscale-stable]
name=Tailscale stable
baseurl=https://pkgs.tailscale.com/stable/fedora/\$basearch
enabled=1
type=rpm
repo_gpgcheck=1
gpgcheck=1
gpgkey=https://pkgs.tailscale.com/stable/fedora/repo.gpg
EOF

rpm-ostree install tailscale

sudo systemctl enable tailscaled

rm -f /etc/yum.repos.d/tailscale.repo
