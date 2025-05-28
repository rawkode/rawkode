import { defineModule } from "../../core/module-builder.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { Action, type ActionContext, type SideEffect } from "../../core/action.ts";
import { SystemdUnit } from "../../utils/systemd/mod.ts";

const home = import.meta.env.HOME;
const gitSignCredentialCachePath = `${home}/Code/bin`;

class GitSignSetupAction extends Action {
	constructor() {
		super(
			"Setup GitSign",
			"Download and configure GitSign credential cache",
			{},
		);
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		return [
			{
				type: "file_create",
				description: "Download gitsign-credential-cache binary",
				target: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
			},
			{
				type: "systemd_unit",
				description: "Create gitsign-credential-cache.socket",
				target: "gitsign-credential-cache.socket",
			},
			{
				type: "systemd_unit",
				description: "Create gitsign-credential-cache.service",
				target: "gitsign-credential-cache.service",
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		const credentialCache = await fetch(
			"https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
		);

		mkdirSync(gitSignCredentialCachePath, { recursive: true });

		writeFileSync(
			`${gitSignCredentialCachePath}/gitsign-credential-cache`,
			new Uint8Array(await credentialCache.arrayBuffer()),
		);

		chmodSync(`${gitSignCredentialCachePath}/gitsign-credential-cache`, 0o755);

		new SystemdUnit("gitsign-credential-cache.socket", {
			type: "socket",
			scope: "user",
			description: "GitSign credential cache socket",
			listenStream: "%C/sigstore/gitsign/cache.sock",
			directoryMode: "0700",
			wantedBy: "default.target",
		}).install();

		new SystemdUnit("gitsign-credential-cache.service", {
			description: "GitSign credential cache",
			type: "simple",
			scope: "user",
			execStart: `${gitSignCredentialCachePath}/gitsign-credential-cache`,
			wantedBy: "default.target",
		})
			.install()
			.enable();
	}
}

export default defineModule("git")
	.description("Git version control configuration")
	.tags("command-line", "development")
	.packageInstall({
		manager: "arch",
		packages: ["gitsign"],
	})
	.symlink({
		source: `${import.meta.dirname}/config`,
		target: "~/.config/git/config",
	})
	.customAction(new GitSignSetupAction())
	.build();
