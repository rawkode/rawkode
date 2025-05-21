import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["nushell"]);

await $`nu -c '$nu.user-autoload-dirs | each { |d| mkdir $d }' out+err>/dev/null`;

ensureHomeSymlink(
  `${import.meta.dirname}/config.nu`,
  ".config/nushell/config.nu",
);

ensureHomeSymlink(
  `${import.meta.dirname}/catppuccin.nu`,
  ".config/nushell/catppuccin.nu",
);

ensureHomeSymlink(`${import.meta.dirname}/env.nu`, ".config/nushell/env.nu");
