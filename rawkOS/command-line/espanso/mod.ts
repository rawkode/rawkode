import { runCommand } from "../../utils/commands/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["espanso-wayland"]);
ensureHomeSymlink(
  `${import.meta.dirname}/config`,
  ".config/espanso/config",
);

ensureHomeSymlink(
  `${import.meta.dirname}/match`,
  ".config/espanso/match",
);

runCommand("systemctl", ["--user", "enable", "--now", "espanso.service"]);
