import { defineModule } from "@rawkode/dhd/core/module-builder.ts";
import { conditions } from "@rawkode/dhd/core/conditions.ts";

export default defineModule("kde")
	.description("KDE desktop environment")
	.tags("desktop", "kde", "ui")
	.when(conditions.isKde)
	.packageInstall({
		manager: "pacman",
		packages: ["kaccounts-providers", "kio-gdrive"],
	})
	.build();
