import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["1password", "1password-cli"]);
await $`sudo mkdir --parents /etc/1password`;
$`sudo cp ${import.meta.dirname}/custom_allowed_browsers /etc/1password/custom_allowed_browsers`;

ensureHomeSymlink(`${import.meta.dirname}/ssh.conf`, ".ssh/config");
