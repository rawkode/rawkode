import { ensureHomeSymlink } from "../../../utils/files/mod.ts";
import { archInstall } from "../../../utils/package/mod.ts";

archInstall(["swaync"]);

// ensureHomeSymlink(`${import.meta.dirname}/config`, ".config/waybar/config");
