import { defineModule, packageInstall, linkDotfile, executeCommand } from "@korora-tech/dhd";

const home = import.meta.env.HOME;
const gitSignCredentialCachePath = `${home}/Code/bin`;

export default defineModule("git")
	.description("Git version control")
	.with(() => [
		packageInstall({
			names: ["gitsign"],
		}),
		linkDotfile({
			source: "config",
			target: "git/config",
		}),
		linkDotfile({
			source: "gitsign.fish",
			target: "fish/conf.d/gitsign.fish",
		}),
		linkDotfile({
			source: "gitsign.nu",
			target: "nushell/autoload/gitsign.nu",
		}),
		executeCommand({
			command: "mkdir",
			args: ["-p", gitSignCredentialCachePath],
		}),
		executeCommand({
			command: "mkdir",
			args: ["-p", `${home}/.cache/sigstore/gitsign`],
		}),
		// TODO: httpDownload not yet available in dhd
		// httpDownload({
		// 	url: "https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
		// 	destination: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
		// 	checksum: {
		// 		algorithm: "sha256",
		// 		value: "cfd2bf2c0e81668a7b9263e3b76c857783d6edad2ad43a4013da4be1346b9fb5",
		// 	},
		// 	mode: 0o755,
		// }),
		// TODO: systemdSocket not yet available in dhd
		// systemdSocket({
		// 	name: "gitsign-credential-cache.socket",
		// 	description: "Gitsign credential cache socket",
		// 	listenStream: `${home}/.cache/sigstore/gitsign/cache.sock`,
		// 	scope: "user",
		// }),
		// TODO: systemdService not yet available in dhd
		// systemdService({
		// 	name: "gitsign-credential-cache.service",
		// 	description: "Gitsign credential cache daemon",
		// 	execStart: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
		// 	type: "simple",
		// 	scope: "user",
		// 	restart: "on-failure",
		// 	restartSec: 5,
		// }),
	]);
