import { defineModule, copyFile } from "@korora-tech/dhd";

export default defineModule("dns")
	.description("DNS configuration")
	.tags("network", "dns")
	.with(() => [
		copyFile({
			source: "hosts",
		destination: "/etc/hosts",
		privileged: true,
	}),
		copyFile({
			source: "resolved.conf",
		destination: "/etc/systemd/resolved.conf",
		privileged: true,
	}),
	]);
