// TODO Needs conditional constraint, only run when fingerprint reader is present
export default defineModule("fprintd")
	.description("Fingerprint authentication support")
	.tags(["security", "authentication"])
	.actions([
		packageInstall({
			names: ["fprintd"],
		}),
		// TODO needs a proper action / atom for copying files
		// copyFile({
		// 	source: "sudo",
		// 	destination: "/etc/pam.d/sudo",
		// 	requires_privilege_escalation: true,
		// }),
	]);
