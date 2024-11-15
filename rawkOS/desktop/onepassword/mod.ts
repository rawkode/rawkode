import { $ } from "zx";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["1password", "1password-cli"]);
await $`mkdir --parents /etc/1password`;
$`sudo cp ${import.meta.dirname}/custom_allowed_browsers /etc/1password/custom_allowed_browsers`;
