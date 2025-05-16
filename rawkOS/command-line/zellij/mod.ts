import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["zellij"]);
ensureHomeSymlink(
	`${import.meta.dirname}/config.kdl`,
	".config/zellij/config.kdl",
);
