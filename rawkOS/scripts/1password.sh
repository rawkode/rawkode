#!/usr/bin/env sh
set -e

## Modified from
## https://github.com/b-/bluefin/blob/bri/scripts/1password.sh
mv /var/opt/1Password /usr/lib/1Password

rm /usr/bin/1password
ln -s /usr/lib/1Password/1password /usr/bin/1password

chmod 4755 /usr/lib/1Password/chrome-sandbox

GID_ONEPASSWORD="1500"
GID_ONEPASSWORDCLI="1600"

cat >/usr/lib/tmpfiles.d/onepassword.conf <<EOF
L  /opt/1Password  -  -  -  -  /usr/lib/1Password
EOF

BROWSER_SUPPORT_PATH="/usr/lib/1Password/1Password-BrowserSupport"

chgrp "${GID_ONEPASSWORD}" "${BROWSER_SUPPORT_PATH}"
chmod g+s "${BROWSER_SUPPORT_PATH}"

chown root:${GID_ONEPASSWORDCLI} /usr/bin/op
chmod g+s /usr/bin/op

cat >/usr/lib/sysusers.d/onepassword.conf <<EOF
g     onepassword ${BROWSER_SUPPORT_PATH}
g     onepassword-cli /usr/bin/op
EOF

mkdir -p /etc/1password
cat >/etc/1password/custom_allowed_browsers <<EOF
vivaldi
EOF
