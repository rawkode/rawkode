// Helper function for copyFile
function copyFile(config: CopyFile): ActionType {
	return {
		type: "CopyFile",
		...config,
	};
}

export default defineModule("onepassword")
	.description("Password manager")
	.tags(["desktop", "security", "passwords"])
	.actions([
		packageInstall({
			names: ["1password", "1password-cli"],
		}),
		linkDotfile({
			from: "ssh.conf",
			to: ".ssh/config",
			force: true,
		}),
		copyFile({
			source: "custom_allowed_browsers",
			destination: "/etc/1password/custom_allowed_browsers",
			requires_privilege_escalation: true,
		}),
	]);
