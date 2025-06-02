import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

const home = import.meta.env.HOME;
const gitSignCredentialCachePath = `${home}/Code/bin`;

export default defineModule("git")
	.description("Git version control")
	.tags("cli", "development", "vcs")
	.packageInstall({
		manager: "pacman",
		packages: ["gitsign"],
	})
	.symlink({
		source: "config",
		target: ".config/git/config",
	})
	.symlink({
		source: "gitsign.fish",
		target: ".config/fish/conf.d/gitsign.fish",
	})
	.symlink({
		source: "gitsign.nu",
		target: ".config/nushell/autoload/gitsign.nu",
	})
	.command({
		command: "mkdir",
		args: ["-p", gitSignCredentialCachePath],
	})
	.command({
		command: "mkdir",
		args: ["-p", `${home}/.cache/sigstore/gitsign`],
	})
	.httpDownload({
		url: "https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
		destination: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
		checksum: {
			algorithm: "sha256",
			value: "cfd2bf2c0e81668a7b9263e3b76c857783d6edad2ad43a4013da4be1346b9fb5",
		},
		mode: 0o755,
	})
	.systemdSocket({
		name: "gitsign-credential-cache.socket",
		description: "Gitsign credential cache socket",
		listenStream: `${home}/.cache/sigstore/gitsign/cache.sock`,
		scope: "user",
	})
	.systemdService({
		name: "gitsign-credential-cache.service",
		description: "Gitsign credential cache daemon",
		execStart: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
		type: "simple",
		scope: "user",
		restart: "on-failure",
		restartSec: 5,
	})
	.build();
