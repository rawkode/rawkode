import { defineModule, packageInstall, copyFile } from "@korora-tech/dhd";
import { conditions } from "@korora-tech/dhd";

export default defineModule("fprintd")
	.description("Fingerprint authentication support")
	.tags("security", "authentication")
	.with(() => [
		packageInstall({
			names: ["fprintd"],
	}),
		copyFile({
			source: "sudo",
		destination: "/etc/pam.d/sudo",
		privileged: true,
	}),
	]);
