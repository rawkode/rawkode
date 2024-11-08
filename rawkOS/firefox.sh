#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF | sudo tee /etc/yum.repos.d/firefox-dev.repo
[copr:copr.fedorainfracloud.org:the4runner:firefox-dev]
name=Copr repo for firefox-dev owned by the4runner
baseurl=https://download.copr.fedorainfracloud.org/results/the4runner/firefox-dev/fedora-\$releasever-\$basearch/
type=rpm-md
skip_if_unavailable=True
gpgcheck=1
gpgkey=https://download.copr.fedorainfracloud.org/results/the4runner/firefox-dev/pubkey.gpg
repo_gpgcheck=0
enabled=1
enabled_metadata=1
EOF

rpm --import https://download.copr.fedorainfracloud.org/results/the4runner/firefox-dev/pubkey.gpg

rpm-ostree install firefox-dev

mv /var/opt/firefox-dev /usr/lib/firefox-dev

cat >/usr/lib/tmpfiles.d/firefox.conf <<EOF
L  /opt/firefox-dev  -  -  -  -  /usr/lib/firefox-dev
EOF

rm /etc/yum.repos.d/firefox-dev.repo -f
