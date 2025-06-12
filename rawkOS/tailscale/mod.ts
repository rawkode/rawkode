export default defineModule("tailscale")
	.description("VPN mesh network")
	.tags(["system"])
	.actions([
		packageInstall({
			names: ["tailscale"],
		}),
	]);
