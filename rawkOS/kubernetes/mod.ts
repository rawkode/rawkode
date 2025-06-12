export default defineModule("kubernetes")
	.description("Kubernetes tools")
	.tags(["terminal", "development"])
	.actions([
		packageInstall({
			names: ["kubectl"],
		}),
	]);
