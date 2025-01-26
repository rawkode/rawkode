import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["ghostty"]);
ensureHomeSymlink(
  `${import.meta.dirname}/config.ini`,
  ".config/ghostty/config",
);
