import { runPrivilegedCommand } from "../../utils/commands/mod.ts";

// Why is this needed is beyond me ... 😂
runPrivilegedCommand("cp", [`${import.meta.dirname}/hosts`, "/etc/hosts"]);
runPrivilegedCommand("cp", [
  `${import.meta.dirname}/resolved.conf`,
  "/etc/systemd/resolved.conf",
]);
