#!/usr/bin/env sh
set -e

echo "Installing 1Password"

# On libostree systems, /opt is a symlink to /var/opt,
# which actually only exists on the live system. /var is
# a separate mutable, stateful FS that's overlaid onto
# the ostree rootfs. Therefore we need to install it into
# /usr/lib/1Password instead, and dynamically create a
# symbolic link /opt/1Password => /usr/lib/1Password upon
# boot.

mkdir -p /var/opt
rpm-ostree install 1password 1password-cli

mv /var/opt/1Password /usr/lib/1Password
rm /usr/bin/1password
ln -s /opt/1Password/1password /usr/bin/1password

chmod 4755 /usr/lib/1Password/chrome-sandbox
cd /usr/lib/1Password

GID_ONEPASSWORD="1500"
GID_ONEPASSWORDCLI="1600"
BROWSER_SUPPORT_PATH="/usr/lib/1Password/1Password-BrowserSupport"

chgrp "${GID_ONEPASSWORD}" "${BROWSER_SUPPORT_PATH}"
chmod g+s "${BROWSER_SUPPORT_PATH}"

cat >/usr/lib/tmpfiles.d/onepassword.conf <<EOF
L  /opt/1Password  -  -  -  -  /usr/lib/1Password
EOF

chown root:${GID_ONEPASSWORDCLI} /usr/bin/op
chmod g+s /usr/bin/op

cat >/usr/lib/sysusers.d/onepassword.conf <<EOF
g     onepassword-cli /usr/bin/op
EOF
