import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
  "catppuccin-cursors-mocha",
  "gauntlet-bin",
  "mako",
  "niri",
  "polkit-gnome",
  "seahorse",
  "xwayland-satellite",
]);

await import("./waybar/mod.ts");
await import("./swaync/mod.ts");

ensureHomeSymlink(
  `${import.meta.dirname}/config.kdl`,
  ".config/niri/config.kdl",
);
