export default defineModule("git")
	.description("Git version control")
	.actions([
		packageInstall({
			names: ["gitsign"],
		}),
		// TODO This should be its own gitConfig action
		// with complete typed object for Git configs
		linkDotfile({
			from: "config",
			to: "git/config",
			force: true,
		}),
		linkDotfile({
			from: "gitsign.fish",
			to: "fish/conf.d/gitsign.fish",
			force: true,
		}),
		linkDotfile({
			from: "gitsign.nu",
			to: "nushell/autoload/gitsign.nu",
			force: true,
		}),
		executeCommand({
			command: "mkdir",
			args: ["-p", "~/Code/bin"],
			escalate: false,
		}),
		executeCommand({
			command: "mkdir",
			args: ["-p", "~/.cache/sigstore/gitsign"],
			escalate: false,
		}),
		httpDownload({
			url: "https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
			destination: "~/Code/bin/gitsign-credential-cache",
			checksum: {
				algorithm: "sha256",
				value:
					"cfd2bf2c0e81668a7b9263e3b76c857783d6edad2ad43a4013da4be1346b9fb5",
			},
			mode: 0o755,
		}),
		systemdSocket({
			name: "gitsign-credential-cache.socket",
			description: "Gitsign credential cache socket",
			// TODO: Why isn't the serde camelCase working?
			listen_stream: "~/.cache/sigstore/gitsign/cache.sock",
			scope: "user",
		}),
		systemdService({
			name: "gitsign-credential-cache.service",
			description: "Gitsign credential cache daemon",
			// TODO: Why isn't the serde camelCase working?
			exec_start: "~/Code/bin/gitsign-credential-cache",
			// TODO: Why isn't the serde camelCase working?
			service_type: "simple",
			scope: "user",
			restart: "on-failure",
			// TODO: Why isn't the serde camelCase working?
			restart_sec: 5,
		}),
	]);
