import { defineModule } from "../../core/module-builder.ts";

export default defineModule("tailscale")
	.description("VPN mesh network")
	.tags("cli", "network", "vpn")
	.packageInstall({
		manager: "pacman",
		packages: ["tailscale"],
	})
	.build();
