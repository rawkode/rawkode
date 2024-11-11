import { $ } from "zx";
import { installPackages } from "../../utils/package/mod.ts";
import { SystemdUnit } from "../../utils/systemd/mod.ts";

export default async () => {
	await installPackages([
		"https://github.com/sigstore/gitsign/releases/download/v0.7.1/gitsign_0.7.1_linux_amd64.rpm",
	]);

	const credentialCache = await fetch(
		"https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
	);

	Deno.writeFileSync(
		"/usr/bin/gitsign-credential-cache",
		new Uint8Array(await credentialCache.arrayBuffer()),
	);
	await $`chmod +x /usr/bin/gitsign-credential-cache`;

	new SystemdUnit("gitsign-credential-cache.service", {
		description: "GitSign credential cache",
		type: "simple",
		scope: "user",
		execStart: "/usr/bin/gitsign-credential-cache",
		wantedBy: "default.target",
	}).install();

	new SystemdUnit("gitsign-credential-cache.socket", {
		type: "socket",
		scope: "user",
		description: "GitSign credential cache socket",
		listenStream: "%C/sigstore/gitsign/cache.sock",
		directoryMode: "0700",
		wantedBy: "default.target",
	}).install();
};
