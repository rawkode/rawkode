import {
	defineModule,
	packageInstall,
	executeCommand,
	userGroup,
} from "@korora-tech/dhd";

export default defineModule("docker")
	.description("Container runtime")
	.with(() => [
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
