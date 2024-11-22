import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["niri", "mako", "walker-bin"]);

ensureHomeSymlink(import.meta.dirname + "/config.kdl", ".config/niri/config.kdl");
ensureHomeSymlink(import.meta.dirname + "/walker.json", ".config/walker/config.json");

