export default defineModule("podman")
	.description("Container runtime")
	.tags(["cli", "containers", "development"])
	.actions([
		packageInstall({
			names: ["podman"],
		}),
	]);
