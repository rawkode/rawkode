import { defineModule } from "../../core/module-builder.ts";

export default defineModule("dns")
	.description("DNS configuration")
	.tags("network", "dns")
	.fileCopy({
		source: "hosts",
		destination: "/etc/hosts",
		privileged: true,
	})
	.fileCopy({
		source: "resolved.conf",
		destination: "/etc/systemd/resolved.conf",
		privileged: true,
	})
	.build();
