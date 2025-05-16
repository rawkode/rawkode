import { existsSync } from "node:fs";
import { runCommand } from "../../utils/commands/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

const home = import.meta.env.HOME;

if (!existsSync(`${home}/.local/google-cloud-sdk`)) {
	await runCommand("curl", [
		"-o",
		"/tmp/google-cloud-sdk.tar.gz",
		"https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz",
	]);

	await runCommand("tar", [
		"-xzf",
		"/tmp/google-cloud-sdk.tar.gz",
		"-C",
		`${home}/.local`,
	]);
}

await runCommand("bash", [
	`${home}/.local/google-cloud-sdk/install.sh`,
	"--usage-reporting=false",
	"--path-update=false",
	"--quiet",
]);

ensureHomeSymlink(
	`${import.meta.dirname}/google-cloud.fish`,
	".config/fish/conf.d/google-cloud.fish",
);
