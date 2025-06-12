export default defineModule("gitbutler")
	.description("Git branch management")
	.tags(["desktop", "development"])
	.actions([
		packageInstall({
			names: ["gitbutler-bin"],
		}),
	]);
