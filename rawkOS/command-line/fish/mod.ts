import { whichSync } from "@david/which";
import { runPrivilegedCommand } from "../../utils/commands/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

archInstall(["fish"]);

const fishShell = whichSync("fish");

if (!fishShell) {
  console.error(
    "Cannot set the default shell to fish, as it could not be found.",
  );
  Deno.exit(1);
}

// Could do this without sudo,
// but want to rely on sudo caching.
// Running as a user always requires
// a password prompt
runPrivilegedCommand("chsh", ["-s", fishShell, "rawkode"]);

ensureHomeSymlink(
  `${import.meta.dirname}/magic-enter.fish`,
  `.config/fish/conf.d/magic-enter.fish`,
);

ensureHomeSymlink(
  `${import.meta.dirname}/aliases.fish`,
  `.config/fish/conf.d/aliases.fish`,
);
