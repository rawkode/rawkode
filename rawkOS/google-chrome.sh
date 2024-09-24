#!/usr/bin/env bash
set -eoux pipefail

mkdir -p /var/lib/alternatives

cat <<EOF >/etc/yum.repos.d/google-chrome.repo
[google-chrome]
name=google-chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
EOF

rpm --import https://dl.google.com/linux/linux_signing_key.pub

rpm-ostree install google-chrome-stable

mv /var/opt/google /usr/lib/google

cat >/usr/lib/tmpfiles.d/google.conf <<EOF
L  /opt/google  -  -  -  -  /usr/lib/google
EOF

rm /etc/yum.repos.d/google-chrome.repo -f
