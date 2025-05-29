import { defineModule } from "@rawkode/dhd/core/module-builder.ts";
import { conditions } from "@rawkode/dhd/core/conditions.ts";

export default defineModule("fprintd")
	.description("Fingerprint authentication support")
	.tags("security", "authentication")
	.when(conditions.hasFingerprint)
	.packageInstall({
		manager: "pacman",
		packages: ["fprintd"],
	})
	.when(conditions.hasFingerprint)
	.fileCopy({
		source: "sudo",
		destination: "/etc/pam.d/sudo",
		privileged: true,
	})
	.build();
