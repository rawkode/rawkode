// Helper function for copyFile
function copyFile(config: CopyFile): ActionType {
	return {
		type: "CopyFile",
		...config,
	};
}

export default defineModule("fprintd")
	.description("Fingerprint authentication support")
	.tags(["security", "authentication"])
	.actions([
		packageInstall({
			names: ["fprintd"],
		}),
		copyFile({
			source: "sudo",
			destination: "/etc/pam.d/sudo",
			requires_privilege_escalation: true,
		}),
	]);
