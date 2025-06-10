// Helper function for copyFile
function copyFile(config: CopyFile): ActionType {
	return {
		type: "CopyFile",
		...config,
	};
}

export default defineModule("dns")
	.description("DNS configuration")
	.tags(["network", "dns"])
	.actions([
		copyFile({
			source: "hosts",
			destination: "/etc/hosts",
			requires_privilege_escalation: true,
		}),
		copyFile({
			source: "resolved.conf",
			destination: "/etc/systemd/resolved.conf",
			requires_privilege_escalation: true,
		}),
	]);
