import { defineModule, packageInstall, linkDotfile, copyFile } from "@korora-tech/dhd";

export default defineModule("onepassword")
	.description("Password manager")
	.tags("desktop", "security", "passwords")
	.with(() => [
		packageInstall({
			names: ["1password", "1password-cli"],
	}),
		linkDotfile({
			source: "ssh.conf",
		target: ".ssh/config",
	}),
		copyFile({
			source: "custom_allowed_browsers",
		destination: "/etc/1password/custom_allowed_browsers",
		privileged: true,
	}),
	]);
