export default defineModule("docker")
	.description("Container runtime")
	.actions([
		packageInstall({
			names: ["docker", "docker-compose"],
		}),
		userGroup({
			user: "current",
			groups: ["docker"],
		}),
		executeCommand({
			command: "systemctl",
			args: ["disable", "docker.service"],
			privileged: true,
		}),
	]);
