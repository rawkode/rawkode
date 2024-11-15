import { $ } from "zx";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall([
	"docker-ce",
	"docker-ce-cli",
	"containerd.io",
	"docker-buildx-plugin",
	"docker-compose-plugin",
]);

// Mostly using podman, but need this on-demand
await $`systemctl disable docker.service`;
