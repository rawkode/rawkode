import { exists } from "@std/fs/exists";
import { runCommand } from "../../utils/commands/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

const home = Deno.env.get("HOME")!;

if (!(await exists(`${home}/.local/google-cloud-sdk`))) {
	runCommand("curl", [
		"-o",
		"/tmp/google-cloud-sdk.tar.gz",
		"https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz",
	]);

	runCommand("tar", [
		"-xzf",
		"/tmp/google-cloud-sdk.tar.gz",
		"-C",
		`${home}/.local`,
	]);
}

runCommand("bash", [
	`${home}/.local/google-cloud-sdk/install.sh`,
	"--usage-reporting=false",
	"--path-update=false",
	"--quiet",
]);

ensureHomeSymlink(
	`${import.meta.dirname}/google-cloud.fish`,
	".config/fish/conf.d/google-cloud.fish",
);
