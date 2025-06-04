import { defineModule, packageInstall, executeCommand } from "@korora-tech/dhd";

export default defineModule("docker")
	.description("Container runtime")
	.with(() => [
		packageInstall({
			names: ["docker", "docker-compose"],
		}),
		// TODO: Add user to docker group - customAction not yet available in dhd
		// customAction({
		// 	name: "Add user to docker group",
		// 	description: "Add current user to docker group",
		// 	async plan(context) {
		// 		return [
		// 			{
		// 				type: "command_run",
		// 				description: `Add ${context.system.user.name} to docker group`,
		// 				target: "usermod",
		// 				requiresElevation: true,
		// 			},
		// 		];
		// 	},
		// 	async apply(context) {
		// 		if (context.dryRun) return;
		// 		const { $ } = await import("bun");
		// 		await $`sudo usermod -aG docker ${context.system.user.name}`;
		// 	},
		// }),
		executeCommand({
			command: "systemctl",
			args: ["disable", "docker.service"],
			privileged: true,
		}),
	]);
