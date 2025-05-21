import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["zoxide", "fzf"]);

await $`nu -c 'zoxide init nushell | save -f ($nu.user-autoload-dirs | path join "zoxide.nu")'`;

ensureHomeSymlink(
	`${import.meta.dirname}/zoxide.fish`,
	".config/fish/conf.d/zoxide.fish",
);
