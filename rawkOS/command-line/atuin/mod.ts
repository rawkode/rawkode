import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["atuin"]);

await $`nu -c 'atuin init nu | save -f ($nu.user-autoload-dirs | path join "atuin.nu")'`;

ensureHomeSymlink(
  `${import.meta.dirname}/config.toml`,
  ".config/atuin/config.toml",
);

ensureHomeSymlink(
  `${import.meta.dirname}/atuin.fish`,
  ".config/fish/conf.d/atuin.fish",
);
