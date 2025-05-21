import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
  "catppuccin-cursors-mocha",
  "gauntlet-bin",
  "mako",
  "niri",
  "polkit-gnome",
  "seahorse",
  "swww",
  "wireplumber",
  "xdg-desktop-portal-gnome",
  "xwayland-satellite",
]);

await import("./waybar/mod.ts");
await import("./swaync/mod.ts");

ensureHomeSymlink(
  `${import.meta.dirname}/config.kdl`,
  ".config/niri/config.kdl",
);

ensureHomeSymlink(
  `${import.meta.dirname}/portals.conf`,
  ".config/xdg-desktop-portal/portals.conf",
);
