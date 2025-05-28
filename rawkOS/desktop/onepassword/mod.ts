import { defineModule } from "../../core/module-builder.ts";

export default defineModule("onepassword")
	.description("Password manager")
	.tags("desktop", "security", "passwords")
	.packageInstall({
		manager: "pacman",
		packages: ["1password", "1password-cli"],
	})
	.command({
		command: "mkdir",
		args: ["--parents", "/etc/1password"],
		privileged: true,
	})
	.fileCopy({
		source: "custom_allowed_browsers",
		destination: "/etc/1password/custom_allowed_browsers",
		privileged: true,
	})
	.symlink({
		source: "ssh.conf",
		target: ".ssh/config",
	})
	.build();
