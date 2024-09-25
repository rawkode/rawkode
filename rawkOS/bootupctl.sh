#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF | sudo tee /etc/yum.repos.d/bootupctl.repo
[bootc-fedora]
name=Copr repo for bootc owned by rhcontainerbot
baseurl=https://download.copr.fedorainfracloud.org/results/rhcontainerbot/bootc/fedora-\$releasever-\$basearch/
type=rpm-md
skip_if_unavailable=True
gpgcheck=1
gpgkey=https://download.copr.fedorainfracloud.org/results/rhcontainerbot/bootc/pubkey.gpg
repo_gpgcheck=0
enabled=1
enabled_metadata=1

[coreos-continuous-fedora]
name=Copr repo for continuous owned by @CoreOS
baseurl=https://download.copr.fedorainfracloud.org/results/@CoreOS/continuous/fedora-\$releasever-\$basearch/
type=rpm-md
skip_if_unavailable=True
gpgcheck=1
gpgkey=https://download.copr.fedorainfracloud.org/results/@CoreOS/continuous/pubkey.gpg
repo_gpgcheck=0
enabled=1
enabled_metadata=1
EOF

rpm-ostree install bootupd bootc

bootupctl backend generate-update-metadata /

rm -rf /etc/yum.repos.d/bootupctl.repo
