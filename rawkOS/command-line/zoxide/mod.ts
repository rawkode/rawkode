import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["zoxide", "fzf"]);

ensureHomeSymlink(
	`${import.meta.dirname}/zoxide.fish`,
	".config/fish/conf.d/zoxide.fish",
);
