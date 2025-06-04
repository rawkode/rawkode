import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("tailscale")
	.description("VPN mesh network")
	.tags("cli", "network", "vpn")
	.with(() => [
		packageInstall({
			names: ["tailscale"],
	}),
	]);
