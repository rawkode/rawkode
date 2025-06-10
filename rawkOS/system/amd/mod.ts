// // Helper function for copyFile
// function copyFile(config: CopyFile): ActionType {
// 	return {
// 		type: "CopyFile",
// 		...config,
// 	};
// }

export default defineModule("amd")
	.description("AMD GPU power management rules")
	.tags(["hardware", "gpu"])
	.actions([
		// TODO waiting for action and atom implementation
		// copyFile({
		// 	source: "udev.rules",
		// 	destination: "/etc/udev/rules.d/30-amdgpu-pm.rules",
		// 	requires_privilege_escalation: true,
		// }),
	]);
