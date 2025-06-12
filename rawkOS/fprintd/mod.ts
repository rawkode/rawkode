export default defineModule("fprintd")
	.description("Fingerprint authentication support")
	.tags(["system"])
	.when(
		or([
			property("hardware.fingerprint").isTrue(),
			command("lsusb").contains("fingerprint", true)
		])
	)
	.actions([
		packageInstall({
			names: ["fprintd"],
		}),
		copyFile({
			source: "sudo",
			target: "/etc/pam.d/sudo",
			escalate: true,
		}),
	]);
