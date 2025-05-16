import { archInstall } from "../../utils/package/mod.ts";
import { runPrivilegedCommand } from "../../utils/commands/mod.ts";

await archInstall(["docker", "docker-compose"]);

runPrivilegedCommand("usermod", ["-aG", "docker", "rawkode"]);

// Mostly using podman, but need this on-demand
runPrivilegedCommand("systemctl", ["disable", "docker.service"]);
