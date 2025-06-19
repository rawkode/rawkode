export default defineModule("dagger")
	.description("Dagger CI/CD")
	.tags(["developer"])
	.actions([
		packageInstall({
			names: ["dagger/dagger", "dagger/container-use:cu"],
			manager: "github",
		}),
	]);
