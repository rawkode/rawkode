#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF | sudo tee /etc/yum.repos.d/cloudflare-warp.repo
[cloudflare-warp-stable]
name=cloudflare-warp-stable
baseurl=https://pkg.cloudflareclient.com/rpm
enabled=1
type=rpm
gpgcheck=1
gpgkey=https://pkg.cloudflareclient.com/pubkey.gpg
EOF

rpm --import https://pkg.cloudflareclient.com/pubkey.gpg

rpm-ostree install cloudflare-warp

systemctl enable warp-svc.service

rm -f /etc/yum.repos.d/cloudflare-warp.repo
