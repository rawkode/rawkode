import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["starship"]);

await $`nu -c 'starship init nu | save -f ($nu.user-autoload-dirs | path join "starship.nu")'`;

ensureHomeSymlink(
  `${import.meta.dirname}/starship.fish`,
  ".config/fish/conf.d/starship.fish",
);

ensureHomeSymlink(
  `${import.meta.dirname}/config.toml`,
  ".config/starship.toml",
);
