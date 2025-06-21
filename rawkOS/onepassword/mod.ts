export default defineModule("onepassword")
	.description("Password manager")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["1password", "1password-cli"],
		}),
		linkFile({
			target: "ssh.conf",
			source: "~/.ssh/config",
			force: true,
		}),
		copyFile({
			source: "custom_allowed_browsers",
			target: "/etc/1password/custom_allowed_browsers",
			escalate: true,
		}),
	]);
