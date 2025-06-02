import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";
import { conditions } from "@korora-tech/dhd/core/conditions.ts";

export default defineModule("amd")
	.description("AMD GPU power management rules")
	.tags("hardware", "gpu")
	.when(conditions.hasAmdGpu)
	.fileCopy({
		source: "udev.rules",
		destination: "/etc/udev/rules.d/30-amdgpu-pm.rules",
		privileged: true,
	})
	.build();
