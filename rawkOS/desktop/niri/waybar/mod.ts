import { ensureHomeSymlink } from "../../../utils/files/mod.ts";
import { archInstall } from "../../../utils/package/mod.ts";

await archInstall(["waybar", "helvum"]);

ensureHomeSymlink(`${import.meta.dirname}/config`, ".config/waybar/config");
ensureHomeSymlink(
	`${import.meta.dirname}/style.css`,
	".config/waybar/style.css",
);
