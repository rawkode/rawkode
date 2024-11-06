#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF >/etc/yum.repos.d/visual-studio-code.repo
[code]
name=Visual Studio Code
baseurl=https://packages.microsoft.com/yumrepos/vscode
enabled=1
gpgcheck=1
gpgkey=https://packages.microsoft.com/keys/microsoft.asc
EOF

rpm --import https://packages.microsoft.com/keys/microsoft.asc

rpm-ostree install code

rm /etc/yum.repos.d/visual-studio-code.repo -f
