import { defineModule, copyFile } from "@korora-tech/dhd";
import { conditions } from "@korora-tech/dhd";

export default defineModule("amd")
	.description("AMD GPU power management rules")
	.tags("hardware", "gpu")
	.with(() => [
		copyFile({
			source: "udev.rules",
		destination: "/etc/udev/rules.d/30-amdgpu-pm.rules",
		privileged: true,
	}),
	]);
