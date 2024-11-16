import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["starship"]);
ensureHomeSymlink(
	`${import.meta.dirname}/starship.fish`,
	".config/fish/conf.d/starship.fish",
);
