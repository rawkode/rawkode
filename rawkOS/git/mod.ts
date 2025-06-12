export default defineModule("git")
	.description("Git version control")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["gitsign"],
		}),

		// User configuration
		gitConfig({
			scope: "global",
			section: "user",
			key: "name",
			value: "David Flanagan",
		}),
		gitConfig({
			scope: "global",
			section: "user",
			key: "email",
			value: "david@rawkode.academy",
		}),

		// Init configuration
		gitConfig({
			scope: "global",
			section: "init",
			key: "defaultBranch",
			value: "main",
		}),

		// Core configuration
		gitConfig({
			scope: "global",
			section: "core",
			key: "editor",
			value: "zeditor --wait",
		}),

		// GPG configuration
		gitConfig({
			scope: "global",
			section: "gpg",
			key: "program",
			value: "gpg",
		}),
		gitConfig({
			scope: "global",
			section: "gpg",
			key: "format",
			value: "x509",
		}),
		gitConfig({
			scope: "global",
			section: "gpg.x509",
			key: "program",
			value: "gitsign",
		}),

		// Commit configuration
		gitConfig({
			scope: "global",
			section: "commit",
			key: "gpgSign",
			value: "true",
		}),

		// Aliases
		gitConfig({
			scope: "global",
			section: "alias",
			key: "cane",
			value: "commit --amend --no-edit",
		}),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "co",
			value: "checkout",
		}),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "logp",
			value: "log --pretty=shortlog",
		}),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "logs",
			value: "log --show-signatures",
		}),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "pl",
			value: "pull --ff-only",
		}),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "prune",
			value: "fetch --prune",
		}),
		gitConfig({ scope: "global", section: "alias", key: "ps", value: "push" }),
		gitConfig({
			scope: "global",
			section: "alias",
			key: "root",
			value: "rev-parse --show-toplevel",
		}),

		// Branch configuration
		gitConfig({
			scope: "global",
			section: "branch",
			key: "autoSetupRebase",
			value: "always",
		}),

		// Pull configuration
		gitConfig({
			scope: "global",
			section: "pull",
			key: "default",
			value: "current",
		}),
		gitConfig({
			scope: "global",
			section: "pull",
			key: "rebase",
			value: "true",
		}),

		// Push configuration
		gitConfig({
			scope: "global",
			section: "push",
			key: "default",
			value: "current",
		}),
		gitConfig({
			scope: "global",
			section: "push",
			key: "autoSetupRemote",
			value: "true",
		}),

		// Rebase configuration
		gitConfig({
			scope: "global",
			section: "rebase",
			key: "autosquash",
			value: "true",
		}),
		gitConfig({
			scope: "global",
			section: "rebase",
			key: "autostash",
			value: "true",
		}),

		// Rerere configuration
		gitConfig({
			scope: "global",
			section: "rerere",
			key: "enabled",
			value: "true",
		}),

		// Stash configuration
		gitConfig({
			scope: "global",
			section: "stash",
			key: "showPatch",
			value: "true",
		}),

		// Advice configuration
		gitConfig({
			scope: "global",
			section: "advice",
			key: "statusHints",
			value: "false",
		}),

		// Color configuration
		gitConfig({
			scope: "global",
			section: "color",
			key: "diff",
			value: "true",
		}),
		gitConfig({
			scope: "global",
			section: "color",
			key: "status",
			value: "true",
		}),
		gitConfig({
			scope: "global",
			section: "color",
			key: "branch",
			value: "true",
		}),
		gitConfig({
			scope: "global",
			section: "color",
			key: "interactive",
			value: "true",
		}),
		gitConfig({ scope: "global", section: "color", key: "ui", value: "true" }),

		// Diff configuration
		gitConfig({
			scope: "global",
			section: "diff",
			key: "algorithm",
			value: "minimal",
		}),
		gitConfig({
			scope: "global",
			section: "diff",
			key: "renames",
			value: "copies",
		}),
		gitConfig({ scope: "global", section: "diff", key: "tool", value: "code" }),
		gitConfig({
			scope: "global",
			section: "difftool.code",
			key: "cmd",
			value: "code --wait --diff $LOCAL $REMOTE",
		}),

		// Pretty format configuration
		gitConfig({
			scope: "global",
			section: "pretty",
			key: "shortlog",
			value:
				"format:%C(auto,yellow)%h%C(auto,magenta)% G? %C(auto,cyan)%>(12,trunc)%ad%C(auto,green) %aN %C(auto,reset)%s%C(auto,red)% gD% D",
		}),

		// GitHub credential helper
		gitConfig({
			scope: "global",
			section: "credential.https://github.com",
			key: "helper",
			value: "",
		}),
		gitConfig({
			scope: "global",
			section: "credential.https://github.com",
			key: "helper",
			value: "!/usr/bin/gh auth git-credential",
		}),
		gitConfig({
			scope: "global",
			section: "credential.https://gist.github.com",
			key: "helper",
			value: "",
		}),
		gitConfig({
			scope: "global",
			section: "credential.https://gist.github.com",
			key: "helper",
			value: "!/usr/bin/gh auth git-credential",
		}),
		linkFile({
			target: "gitsign.fish",
			source: "fish/conf.d/gitsign.fish",
			force: true,
		}),
		linkFile({
			target: "gitsign.nu",
			source: "nushell/autoload/gitsign.nu",
			force: true,
		}),
		directory({
			path: "~/Code/bin",
		}),
		directory({
			path: "~/.cache/sigstore/gitsign",
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
			listenStream: "~/.cache/sigstore/gitsign/cache.sock",
			scope: "user",
		}),
		systemdService({
			name: "gitsign-credential-cache.service",
			description: "Gitsign credential cache daemon",
			execStart: "~/Code/bin/gitsign-credential-cache",
			serviceType: "simple",
			scope: "user",
			restart: "on-failure",
			restartSec: 5,
		}),
	]);
