import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["jujutsu"]);

ensureHomeSymlink(`${import.meta.dirname}/config.toml`, ".config/jj/config.toml");