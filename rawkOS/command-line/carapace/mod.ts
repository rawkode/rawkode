import { $ } from "bun";
import { archInstall } from "../../utils/package/mod";

await archInstall(["carapace-bin"]);
await $`nu -c 'carapace _carapace nushell | save --force ($nu.user-autoload-dirs | path join "carapace.nu")'`;
