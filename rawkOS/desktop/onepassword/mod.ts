import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "1password",
		url: "https://downloads.1password.com/linux/rpm/stable/$basearch",
		keyUrl: "https://downloads.1password.com/linux/keys/1password.asc",
	});

	await installPackages(["1password", "1password-cli"]);

	await $`mv /var/opt/1Password /usr/lib/1Password`;
	await $`rm /usr/bin/1password`;
	await $`ln -s /usr/lib/1Password/1password /usr/bin/1password`;
	await $`chmod 4755 /usr/lib/1Password/chrome-sandbox`;

	const GID_ONEPASSWORD = "1500";
	const GID_ONEPASSWORDCLI = "1600";

	await $`chgrp ${GID_ONEPASSWORD} /usr/lib/1Password/1Password-BrowserSupport`;
	await $`chmod g+s /usr/lib/1Password/1Password-BrowserSupport`;

	await $`chown root:${GID_ONEPASSWORDCLI} /usr/bin/op`;
	await $`chmod g+s /usr/bin/op`;

	await $`mkdir /etc/1password`;

	Deno.writeFileSync(
		"/usr/lib/sysusers.d/onepassword.conf",
		new TextEncoder().encode(`g     onepassword (${GID_ONEPASSWORD})`),
	);
	Deno.writeFileSync(
		"/usr/lib/sysusers.d/onepassword-cli.conf",
		new TextEncoder().encode(`g     onepassword-cli (${GID_ONEPASSWORDCLI})`),
	);

	console.log((await $`cat /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword.conf`).stdout);
};


	// mv /var/opt/1Password /usr/lib/1Password
	// rm /usr/bin/1password
	// ln -s /usr/lib/1Password/1password /usr/bin/1password
	// chmod 4755 /usr/lib/1Password/chrome-sandbox

	// let GID_ONEPASSWORD = "1500"
	// let GID_ONEPASSWORDCLI = "1600"

	// chgrp $GID_ONEPASSWORD /usr/lib/1Password/1Password-BrowserSupport
	// chmod g+s /usr/lib/1Password/1Password-BrowserSupport

	// chown $"root:($GID_ONEPASSWORDCLI)" /usr/bin/op
	// chmod g+s /usr/bin/op

	// mkdir /etc/1password

	// $"g     onepassword ($GID_ONEPASSWORD)" | save /usr/lib/sysusers.d/onepassword.conf
  // $"g     onepassword-cli ($GID_ONEPASSWORDCLI)" | save /usr/lib/sysusers.d/onepassword-cli.conf
	// "L  /opt/1Password  -  -  -  -  /usr/lib/1Password" | save /usr/lib/tmpfiles.d/onepassword.conf

	// rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword.conf
	// rm -f /usr/lib/sysusers.d/30-rpmostree-pkg-group-onepassword-cli.conf
