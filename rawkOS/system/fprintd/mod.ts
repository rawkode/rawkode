import { runPrivilegedCommand } from "../../utils/commands/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
  "fprintd",
]);

runPrivilegedCommand("cp", [`${import.meta.dirname}/sudo`, "/etc/pam.d/sudo"]);
