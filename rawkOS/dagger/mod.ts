export default defineModule("dagger")
	.description("Dagger CI/CD")
	.tags(["developer"])
	.actions([
		packageInstall({
			names: ["dagger/dagger"],
			manager: "github",
		}),
	]);
