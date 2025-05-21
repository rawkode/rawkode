import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["ghostty"]);

ensureHomeSymlink(
	`${import.meta.dirname}/config.ini`,
	".config/ghostty/config",
);
