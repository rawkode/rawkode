import { archInstall } from "../../utils/package/mod.ts";
import { SystemdUnit } from "../../utils/systemd/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

ensureHomeSymlink(`${import.meta.dirname}/config`, ".config/git/config");

const gitSignCredentialCachePath = `${Deno.env.get("HOME")!}/Code/bin`;

archInstall([
	"gitsign",
]);

const credentialCache = await fetch(
	"https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
);

Deno.mkdirSync(gitSignCredentialCachePath, { recursive: true });

Deno.writeFileSync(
	`${gitSignCredentialCachePath}/gitsign-credential-cache`,
	new Uint8Array(await credentialCache.arrayBuffer()),
);

Deno.chmodSync(`${gitSignCredentialCachePath}/gitsign-credential-cache`, 0o755);

new SystemdUnit("gitsign-credential-cache.service", {
	description: "GitSign credential cache",
	type: "simple",
	scope: "user",
	execStart: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
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
