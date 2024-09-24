#!/usr/bin/bash
set -ouex pipefail

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
