import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["ghostty-git"]);
ensureHomeSymlink(`${import.meta.dirname}/config`, ".config/ghostty/config");
