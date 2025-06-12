export default defineModule("docker")
	.description("Container runtime")
	.tags(["developer"])
	.actions([
		packageInstall({
			names: ["docker"],
		}),
		// TODO
		// userGroup({
		// 	user: "current",
		// 	groups: ["docker"],
		// }),
		systemdManage({
			name: "docker.service",
			operation: "disable",
			scope: "system",
		}),
	]);
