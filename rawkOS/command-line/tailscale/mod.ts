export default defineModule("tailscale")
	.description("VPN mesh network")
	.tags(["cli", "network", "vpn"])
	.actions([
		packageInstall({
			names: ["tailscale"],
		}),
	]);
