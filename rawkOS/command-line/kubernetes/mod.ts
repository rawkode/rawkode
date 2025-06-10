export default defineModule("kubernetes")
	.description("Kubernetes tools")
	.tags(["cli", "kubernetes", "cloud"])
	.actions([
		packageInstall({
			names: ["kubectl"],
		}),
	]);
