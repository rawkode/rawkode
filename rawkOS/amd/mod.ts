export default defineModule("amd")
	.description("AMD GPU power management rules")
	.tags(["system"])
	.when(property("hardware.gpuVendor").equals("amd"))
	.actions([
		copyFile({
			source: "udev.rules",
			target: "/etc/udev/rules.d/30-amdgpu-pm.rules",
			escalate: true,
		}),
	]);
