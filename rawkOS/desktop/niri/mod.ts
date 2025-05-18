import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
  "niri",
  "catppuccin-cursors-mocha",
  "gauntlet-bin",
  "mako",
  "polkit-gnome",
  "xwayland-satellite",
]);

ensureHomeSymlink(
  import.meta.dirname + "/config.kdl",
  ".config/niri/config.kdl",
);

await import("./waybar/mod.ts");
await import("./swaync/mod.ts");
