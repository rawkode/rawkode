import { runPrivilegedCommand } from "../../utils/commands/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import * as process from "node:process";
import { which } from "bun";

await archInstall(["fish"]);

const fishShell = which("fish");

if (!fishShell) {
	console.error(
		"Cannot set the default shell to fish, as it could not be found.",
	);
	process.exit(1);
}

runPrivilegedCommand("homectl", ["update", "rawkode", "--shell", fishShell]);

ensureHomeSymlink(
	`${import.meta.dirname}/magic-enter.fish`,
	".config/fish/conf.d/magic-enter.fish",
);

ensureHomeSymlink(
	`${import.meta.dirname}/aliases.fish`,
	".config/fish/conf.d/aliases.fish",
);
