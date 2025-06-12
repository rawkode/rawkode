export default defineModule("podman")
	.description("Container runtime")
	.tags(["terminal", "development"])
	.actions([
		packageInstall({
			names: ["podman"],
		}),
	]);
