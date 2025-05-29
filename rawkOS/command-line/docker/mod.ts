import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("docker")
	.description("Container runtime")
	.tags("cli", "containers", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["docker", "docker-compose"],
	})
	.customAction({
		name: "Add user to docker group",
		description: "Add current user to docker group",
		async plan(context) {
			return [
				{
					type: "command_run",
					description: `Add ${context.system.user.name} to docker group`,
					target: "usermod",
					requiresElevation: true,
				},
			];
		},
		async apply(context) {
			if (context.dryRun) return;
			const { $ } = await import("bun");
			await $`sudo usermod -aG docker ${context.system.user.name}`;
		},
	})
	.command({
		command: "systemctl",
		args: ["disable", "docker.service"],
		privileged: true,
	})
	.build();
