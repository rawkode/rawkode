export default defineModule("gitbutler")
	.description("Git branch management")
	.tags(["desktop", "git", "development"])
	.actions([
		packageInstall({
			names: ["gitbutler-bin"],
		}),
	]);
