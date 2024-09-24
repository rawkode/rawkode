#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF >/etc/yum.repos.d/1password.repo
[1password]
name=1Password Stable Channel
baseurl=https://downloads.1password.com/linux/rpm/stable/\$basearch
enabled=1
gpgcheck=1
type=rpm
repo_gpgcheck=0
gpgkey="https://downloads.1password.com/linux/keys/1password.asc"
EOF

rpm --import https://downloads.1password.com/linux/keys/1password.asc

rpm-ostree install 1password 1password-cli

## Modified from
## https://github.com/b-/bluefin/blob/bri/scripts/1password.sh
mv /var/opt/1Password /usr/lib/1Password

rm /usr/bin/1password
ln -s /usr/lib/1Password/1password /usr/bin/1password

chmod 4755 /usr/lib/1Password/chrome-sandbox

GID_ONEPASSWORD="1500"
GID_ONEPASSWORDCLI="1600"

chgrp ${GID_ONEPASSWORD} /usr/lib/1Password/1Password-BrowserSupport
chmod g+s /usr/lib/1Password/1Password-BrowserSupport

chown root:${GID_ONEPASSWORDCLI} /usr/bin/op
chmod g+s /usr/bin/op

mkdir -p /etc/1password

cat >/usr/lib/sysusers.d/onepassword.conf <<EOF
g     onepassword ${GID_ONEPASSWORD}
EOF

cat >/usr/lib/sysusers.d/onepassword-cli.conf <<EOF
g     onepassword-cli ${GID_ONEPASSWORDCLI}
EOF

rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword.conf
rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword-cli.conf

cat >/usr/lib/tmpfiles.d/onepassword.conf <<EOF
L  /opt/1Password  -  -  -  -  /usr/lib/1Password
EOF

rm -f /etc/yum.repos.d/1password.repo
