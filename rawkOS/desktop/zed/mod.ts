import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["zed"]);

ensureHomeSymlink(
	`${import.meta.dirname}/keymap.json`,
	".config/zed/keymap.json",
);

ensureHomeSymlink(
	`${import.meta.dirname}/settings.json`,
	".config/zed/settings.json",
);
