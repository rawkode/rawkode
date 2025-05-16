import { dconfImport } from "../../utils/dconf/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["catppuccin-cursors-mocha"]);
dconfImport(import.meta.dirname + "/dconf.ini");
ensureHomeSymlink(
  import.meta.dirname + "/gtk-settings.ini",
  ".config/gtk-3.0/settings.ini",
);
ensureHomeSymlink(
  import.meta.dirname + "/gtk-settings.ini",
  ".config/gtk-4.0/settings.ini",
);
