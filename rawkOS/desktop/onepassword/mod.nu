#!/usr/bin/env nu
use ../../utils *

export def main [] {
	package repo add --name "1password" --url "https://downloads.1password.com/linux/rpm/stable/$basearch" --keyUrl "https://downloads.1password.com/linux/keys/1password.asc"
	package repo key import "https://downloads.1password.com/linux/keys/1password.asc"
	package install 1password 1password-cli

	mv /var/opt/1Password /usr/lib/1Password
	rm /usr/bin/1password
	ln -s /usr/lib/1Password/1password /usr/bin/1password
	chmod 4755 /usr/lib/1Password/chrome-sandbox

	let GID_ONEPASSWORD = "1500"
	let GID_ONEPASSWORDCLI = "1600"

	chgrp $GID_ONEPASSWORD /usr/lib/1Password/1Password-BrowserSupport
	chmod g+s /usr/lib/1Password/1Password-BrowserSupport

	chown $"root:($GID_ONEPASSWORDCLI)" /usr/bin/op
	chmod g+s /usr/bin/op

	mkdir /etc/1password

	$"g     onepassword ($GID_ONEPASSWORD)" | save /usr/lib/sysusers.d/onepassword.conf
  $"g     onepassword-cli ($GID_ONEPASSWORDCLI)" | save /usr/lib/sysusers.d/onepassword-cli.conf
	"L  /opt/1Password  -  -  -  -  /usr/lib/1Password" | save /usr/lib/tmpfiles.d/onepassword.conf

	rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword.conf
	rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword-cli.conf
}
