import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["wezterm"]);

ensureHomeSymlink(
  `${import.meta.dirname}/config.lua`,
  ".config/wezterm/wezterm.lua",
);
