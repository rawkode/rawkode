export default defineModule("dns")
	.description("DNS configuration")
	.tags(["system"])
	.actions([
		copyFile({
			source: "hosts",
			target: "/etc/hosts",
			escalate: true,
		}),
		copyFile({
			source: "resolved.conf",
			target: "/etc/systemd/resolved.conf",
			escalate: true,
		}),
	]);
