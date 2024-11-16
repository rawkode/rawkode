import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["atuin"]);

ensureHomeSymlink(
	`${import.meta.dirname}/config.toml`,
	".config/atuin/config.toml",
);

ensureHomeSymlink(
	`${import.meta.dirname}/atuin.fish`,
	".config/fish/conf.d/atuin.fish",
);
